"""MediaStudio's Colab worker: a stateless ComfyUI job runner inside a Colab kernel.

MediaStudio sends this file with ``colab exec``; on its own it only defines things and keeps a
single ``MEDIASTUDIO_WORKER`` in the kernel. MediaStudio then calls, each in a short ``colab exec``:

    MEDIASTUDIO_WORKER.boot(spec)                  start the worker threads (once per runtime)
    MEDIASTUDIO_WORKER.attach(after_seq, seconds)  print the events after a sequence number

The kernel runs one cell at a time and ``attach`` keeps it busy, so everything else
travels as files through the Jupyter Contents API (``colab upload`` and ``colab
download``), which works while a cell runs:

    /content/mediastudio/inbox/<job>.job.json      a job: ComfyUI workflow, inputs, resources
    /content/mediastudio/inbox/inputs/<name>       its input images
    /content/mediastudio/inbox/<job>.cancel        cancel the job
    /content/mediastudio/inbox/<job>.collected     MediaStudio has the outputs: delete all files of the job
    /content/mediastudio/inbox/settings.json       {"idle_seconds": N}
    /content/mediastudio/inbox/detach              end the running ``attach`` (MediaStudio lost its stream)
    /content/mediastudio/outbox/<job>/<file>       outputs until they are collected

Events are lines ``@@mediastudio {...}`` with a sequence number, so a dropped ``attach`` resumes
without losing any. When nothing has happened for the idle time plus a grace period, the
worker ends the runtime itself (``google.colab.runtime.unassign``): a crashed MediaStudio or a
sleeping computer does not keep a paid GPU running.

Only the standard library is imported at module level: MediaStudio's tests import this file too.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import io
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any

WORKER_VERSION = "2"
EVENT_PREFIX = "@@mediastudio "
ATTACH_END_PREFIX = "@@mediastudio-end "
ROOT = Path("/content/mediastudio")
COMFY_DIR = Path("/content/ComfyUI")
COMFY_REPO = "https://github.com/comfyanonymous/ComfyUI.git"
DEFAULT_PORT = 8188
WATCHDOG_GRACE_SECONDS = 120
MAX_NODE_ARCHIVE_BYTES = 50 * 1024 * 1024
DOWNLOAD_CHUNK = 8 * 1024 * 1024
PROGRESS_EVERY_SECONDS = 1.0
FINAL_STATES = {"done", "failed", "cancelled"}
# Jupyter answers an upload by reading the saved file back; a marker consumed sooner turns
# that read into a 404 for MediaStudio, so markers are left alone until they are this old.
MARKER_MIN_AGE_SECONDS = 1.0
SKIPPED_PACK_TOP_LEVEL = {"tests", ".github", "node.zip"}
# Messages MediaStudio's progress monitor understands; the rest (status, binary previews) stay here.
RELAYED_COMFY_EVENTS = {
    "execution_start", "execution_cached", "executing", "progress", "executed",
    "execution_success", "execution_error", "execution_interrupted",
}

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_HF_RESOLVE = re.compile(r"^https://huggingface\.co/(?P<repo>[^/]+/[^/]+)/resolve/(?P<rev>[^/]+)/(?P<path>[^?]+)")


class WorkerError(RuntimeError):
    pass


# --- pure helpers (tested in MediaStudio) ---------------------------------------------------


def is_prompt_id(value: str) -> bool:
    """ComfyUI accepts only canonical lowercase hyphenated UUIDs as client prompt ids."""
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, AttributeError, TypeError):
        return False


def marker_ready(path: Path, now: float | None = None) -> bool:
    try:
        return (time.time() if now is None else now) - path.stat().st_mtime >= MARKER_MIN_AGE_SECONDS
    except OSError:
        return False


def safe_name(value: Any, *, label: str) -> str:
    """A single path segment: no separators, no '..', no leading dot."""
    text = str(value or "")
    if not text or text != os.path.basename(text) or "\\" in text or text.startswith(".") or ".." in text:
        raise WorkerError(f"Unsafe {label}: {text!r}")
    return text


def parse_job(text: str) -> dict[str, Any]:
    """Validate a job file; raises WorkerError with the reason."""
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WorkerError(f"Job is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise WorkerError("Job must be a JSON object.")
    job_id = str(raw.get("id") or "")
    if not is_prompt_id(job_id):
        raise WorkerError(f"Job id must be a lowercase UUID (ComfyUI's prompt id): {job_id[:60]!r}")
    workflow = raw.get("workflow")
    if not isinstance(workflow, dict) or not workflow:
        raise WorkerError("Job has no workflow.")
    inputs = [safe_name(PurePosixPath(str(item)).name, label="input name") for item in raw.get("inputs") or []]
    resources = []
    for item in raw.get("resources") or []:
        if not isinstance(item, dict):
            raise WorkerError("A resource must be an object.")
        url = str(item.get("url") or "")
        if not url.startswith("https://"):
            raise WorkerError(f"Resource URL must be https: {url[:80]!r}")
        sha = str(item.get("sha256") or "").lower() or None
        if sha and not _SHA256.match(sha):
            raise WorkerError(f"Bad sha256 for {item.get('filename')!r}")
        if item.get("cache_key") and not _SHA256.fullmatch(str(item["cache_key"])):
            raise WorkerError("invalid model cache key")
        resources.append({
            "folder": safe_name(item.get("folder"), label="model folder"),
            "filename": safe_name(item.get("filename"), label="model file"),
            "url": url,
            "sha256": sha,
            **({"cache_key": str(item["cache_key"])} if item.get("cache_key") else {}),
        })
    extra = raw.get("extra_data")
    return {
        "id": job_id,
        "client_id": str(raw.get("client_id") or ""),
        "workflow": workflow,
        "extra_data": extra if isinstance(extra, dict) else {},
        "inputs": inputs,
        "resources": resources,
    }


def hf_parts(url: str) -> tuple[str, str, str] | None:
    """(repo, revision, path) of a Hugging Face resolve URL, else None."""
    match = _HF_RESOLVE.match(url)
    if not match:
        return None
    return match["repo"], match["rev"], urllib.parse.unquote(match["path"])


def watchdog_due(*, now: float, last_activity: float, busy: bool, idle_seconds: float, grace: float) -> bool:
    return not busy and now - last_activity > idle_seconds + grace


def output_files(outputs: dict[str, Any]) -> list[dict[str, Any]]:
    """Files ComfyUI reports in a history entry's outputs, by node and media key."""
    files: list[dict[str, Any]] = []
    for node_id, node_outputs in (outputs or {}).items():
        if not isinstance(node_outputs, dict):
            continue
        for media_key, items in node_outputs.items():
            if not isinstance(items, list):
                continue
            for item in items:
                if isinstance(item, dict) and item.get("filename"):
                    files.append({**item, "node_id": str(node_id), "media_key": str(media_key)})
    return files


def archive_members(archive: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, PurePosixPath]]:
    """Strip the single top-level directory; reject absolute, parent or backslash paths."""
    members = []
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts or "\\" in info.filename:
            raise WorkerError(f"Unsafe path in archive: {info.filename}")
        if len(path.parts) < 2 or info.is_dir():
            continue
        relative = PurePosixPath(*path.parts[1:])
        if relative.parts[0] in SKIPPED_PACK_TOP_LEVEL:
            continue
        members.append((info, relative))
    if not members:
        raise WorkerError("Node pack archive is empty.")
    return members


# --- event log ----------------------------------------------------------------------


class EventLog:
    """Numbered events, kept in memory and appended to a file; ``attach`` waits on it."""

    def __init__(self, path: Path | None = None, keep: int = 4000):
        self.path = path
        self._events: deque[dict[str, Any]] = deque(maxlen=keep)
        self._seq = 0
        self._changed = threading.Condition()

    @property
    def last_seq(self) -> int:
        return self._seq

    def emit(self, ev: str, **data: Any) -> dict[str, Any]:
        with self._changed:
            self._seq += 1
            event = {"seq": self._seq, "t": round(time.time(), 3), "ev": ev, **data}
            self._events.append(event)
            if self.path is not None:
                try:
                    with self.path.open("a", encoding="utf-8") as file:
                        file.write(json.dumps(event, ensure_ascii=False) + "\n")
                except OSError:
                    pass
            self._changed.notify_all()
            return event

    def after(self, seq: int) -> list[dict[str, Any]]:
        with self._changed:
            return [event for event in self._events if event["seq"] > seq]

    def wait(self, seq: int, timeout: float) -> list[dict[str, Any]]:
        with self._changed:
            if self._seq <= seq:
                self._changed.wait(timeout)
            return [event for event in self._events if event["seq"] > seq]


# --- a small WebSocket client for ComfyUI's /ws -------------------------------------


class _MiniWebSocket:
    """Text frames only; ping is answered, binary frames (previews) are skipped."""

    def __init__(self, host: str, port: int, path: str, timeout: float = 10.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.sock.sendall((
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii"))
        self._buffer = b""
        while b"\r\n\r\n" not in self._buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise OSError("WebSocket handshake closed")
            self._buffer += chunk
        head, self._buffer = self._buffer.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError(f"WebSocket handshake refused: {head[:80]!r}")

    def _read(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError("WebSocket closed")
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def _send(self, opcode: int, payload: bytes = b"") -> None:
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", length)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv_text(self) -> str | None:
        """The next text message; None after a binary one. Raises socket.timeout when idle."""
        parts: list[bytes] = []
        while True:
            first, second = self._read(2)
            opcode, final = first & 0x0F, bool(first & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if second & 0x80 else b""
            payload = self._read(length)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode == 0x8:
                raise OSError("WebSocket closed by ComfyUI")
            if opcode in (0x1, 0x0):
                parts.append(payload)
                if final:
                    return b"".join(parts).decode("utf-8", errors="replace")
                continue
            if final:
                return None  # binary frame

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


# --- the worker ---------------------------------------------------------------------


class Worker:
    version = WORKER_VERSION

    def __init__(self, *, root: Path = ROOT, comfy_dir: Path = COMFY_DIR, port: int = DEFAULT_PORT):
        self.root, self.comfy_dir, self.port = Path(root), Path(comfy_dir), int(port)
        self.model_cache_dir: Path | None = None
        self._cached_models: set[str] = set()
        self.inbox, self.inputs, self.outbox = self.root / "inbox", self.root / "inbox" / "inputs", self.root / "outbox"
        for folder in (self.inbox, self.inputs, self.outbox):
            folder.mkdir(parents=True, exist_ok=True)
        self.log = EventLog(self.root / "events.jsonl")
        self.client_id = f"mediastudio-worker-{uuid.uuid4().hex}"
        self.stage = "idle"
        self.ready = threading.Event()
        self.idle_seconds = 600.0
        self.grace_seconds = float(WATCHDOG_GRACE_SECONDS)
        self.last_activity = time.time()
        self.jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._file_locks: dict[str, threading.Lock] = {}
        self._prep = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mediastudio-prep")
        self._stop = threading.Event()
        self._started = False
        self._comfy: subprocess.Popen[bytes] | None = None
        self._comfy_restarts = 0

    # --- calls from MediaStudio -------------------------------------------------------------

    def boot(self, spec: dict[str, Any]) -> None:
        """Start the worker threads once; a second call only reports the current state."""
        cache = spec.get("model_cache_dir")
        if cache:
            drive = Path("/content/drive/MyDrive")
            if not drive.is_dir():
                raise WorkerError("google drive is not mounted for the model cache")
            self.model_cache_dir = drive / "VEIL" / "model-cache"
        self.set_idle(spec.get("idle_seconds", self.idle_seconds))
        with self._lock:
            if self._started:
                self.log.emit("hello", stage=self.stage, ready=self.ready.is_set(), version=self.version,
                              jobs={job_id: job["state"] for job_id, job in self.jobs.items()})
                return
            self._started = True
        os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
        self.log.emit("hello", stage="booting", ready=False, version=self.version, jobs={})
        threading.Thread(target=self._boot_and_serve, args=(spec,), daemon=True, name="mediastudio-boot").start()
        threading.Thread(target=self._watchdog, daemon=True, name="mediastudio-watchdog").start()

    def attach(self, after_seq: int = 0, seconds: float = 600.0) -> None:
        """Print events after ``after_seq`` for ``seconds``, then the last sequence number.

        A ``detach`` file ends it early: MediaStudio uploads one when its stream broke, so the
        kernel is free for the next ``attach`` instead of finishing this one unseen.
        """
        detach = self.inbox / "detach"
        # This cell starts only after the previous one ended, so a marker left here is stale.
        detach.unlink(missing_ok=True)
        deadline = time.monotonic() + max(1.0, float(seconds))
        seq = int(after_seq)
        while time.monotonic() < deadline and not self._stop.is_set():
            for event in self.log.wait(seq, timeout=min(0.5, max(0.05, deadline - time.monotonic()))):
                print(EVENT_PREFIX + json.dumps(event, ensure_ascii=False), flush=True)
                seq = event["seq"]
            if marker_ready(detach):
                detach.unlink(missing_ok=True)
                break
        print(ATTACH_END_PREFIX + json.dumps({"last_seq": seq}), flush=True)

    def set_idle(self, seconds: Any) -> None:
        try:
            self.idle_seconds = max(60.0, float(seconds))
        except (TypeError, ValueError):
            pass

    def shutdown(self) -> None:
        self._stop.set()
        if self._comfy is not None and self._comfy.poll() is None:
            self._comfy.terminate()

    # --- activity and the watchdog --------------------------------------------------

    def touch(self) -> None:
        self.last_activity = time.time()

    def busy(self) -> bool:
        with self._lock:
            booting = self.stage not in {"ready", "failed", "idle"}
            return booting or any(job["state"] not in FINAL_STATES for job in self.jobs.values())

    def _watchdog(self) -> None:
        while not self._stop.wait(5.0):
            if watchdog_due(now=time.time(), last_activity=self.last_activity, busy=self.busy(),
                            idle_seconds=self.idle_seconds, grace=self.grace_seconds):
                self.log.emit("idle_stop", idle_seconds=self.idle_seconds)
                time.sleep(1.0)
                self.shutdown()
                try:
                    importlib.import_module("google.colab.runtime").unassign()
                except Exception as exc:  # outside Colab, or the backend refused
                    self.log.emit("error", message=f"Could not end the runtime: {exc}")
                return

    # --- boot -----------------------------------------------------------------------

    def _set_stage(self, stage: str, **data: Any) -> None:
        self.stage = stage
        self.touch()
        self.log.emit("boot", stage=stage, **data)

    def _run(self, command: list[str], *, cwd: Path | None = None, timeout: float = 900.0) -> str:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode != 0:
            tail = (result.stderr or result.stdout).strip()[-600:]
            raise WorkerError(f"{' '.join(command[:4])} failed: {tail}")
        return result.stdout

    def _pip(self, *args: str) -> None:
        uv = shutil.which("uv")
        base = [uv, "pip", "install", "--system", "-q"] if uv else [sys.executable, "-m", "pip", "install", "-q"]
        self._run([*base, *args], timeout=1200.0)

    def _boot_and_serve(self, spec: dict[str, Any]) -> None:
        started = time.time()
        # Jobs that arrive during boot download their models while ComfyUI is installed.
        threading.Thread(target=self._relay, daemon=True, name="mediastudio-relay").start()
        try:
            self._prepare_comfyui(spec)
            self._set_stage("starting")
            self._start_comfyui()
        except Exception as exc:
            self.stage = "failed"
            self.log.emit("boot_failed", message=str(exc), log_tail=self._comfy_log_tail())
            return
        self.stage = "ready"
        self.ready.set()
        self.touch()
        self.log.emit("ready", seconds=round(time.time() - started, 1), gpu=self._gpu_name(),
                      comfyui=spec.get("comfyui", {}).get("commit"), model_cache=bool(self.model_cache_dir))
        threading.Thread(target=self._comfy_events, daemon=True, name="mediastudio-comfy-ws").start()

    def _prepare_comfyui(self, spec: dict[str, Any]) -> None:
        comfy = spec.get("comfyui") or {}
        commit = str(comfy.get("commit") or "")
        self._set_stage("comfyui", commit=commit)
        if not (self.comfy_dir / "main.py").is_file():
            self.comfy_dir.mkdir(parents=True, exist_ok=True)
            self._run(["git", "init", "-q"], cwd=self.comfy_dir)
            self._run(["git", "remote", "add", "origin", str(comfy.get("repo") or COMFY_REPO)], cwd=self.comfy_dir)
            self._run(["git", "fetch", "-q", "--depth", "1", "origin", commit or "HEAD"], cwd=self.comfy_dir)
            self._run(["git", "checkout", "-q", "FETCH_HEAD"], cwd=self.comfy_dir)
        self._set_stage("requirements")
        self._pip("-r", str(self.comfy_dir / "requirements.txt"))
        self._pip("hf_xet")
        packs = spec.get("custom_nodes") or []
        if packs:
            self._set_stage("nodes", count=len(packs))
            for pack in packs:
                self._install_pack(pack)

    def _install_pack(self, pack: dict[str, Any]) -> None:
        folder = safe_name(pack.get("folder"), label="node folder")
        target = self.comfy_dir / "custom_nodes" / folder
        if target.exists():
            return
        url = str(pack.get("archive_url") or "")
        if not url.startswith("https://"):
            raise WorkerError(f"Node pack {folder} has no https archive URL.")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "mediastudio-colab-worker"}), timeout=60) as response:
            data = response.read(MAX_NODE_ARCHIVE_BYTES + 1)
        if len(data) > MAX_NODE_ARCHIVE_BYTES:
            raise WorkerError(f"Node pack {folder} archive is unexpectedly large.")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive_members(archive)
            verify = next((info for info, rel in members if str(rel) == pack.get("verify_file")), None)
            if verify is None or hashlib.sha256(archive.read(verify)).hexdigest() != pack.get("verify_sha256"):
                raise WorkerError(f"Node pack {folder} does not match the reviewed commit.")
            staging = target.with_name(f".{folder}.staging")
            shutil.rmtree(staging, ignore_errors=True)
            for info, relative in members:
                destination = staging.joinpath(*relative.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(info))
            staging.rename(target)
        requirements = target / "requirements.txt"
        if requirements.is_file() and requirements.read_text(encoding="utf-8", errors="replace").strip():
            self._pip("-r", str(requirements))

    def _start_comfyui(self) -> None:
        log = (self.root / "comfyui.log").open("ab")
        self._comfy = subprocess.Popen(
            [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(self.port),
             "--disable-auto-launch", "--preview-method", "none"],
            cwd=self.comfy_dir, stdout=log, stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 600
        while time.time() < deadline:
            if self._comfy.poll() is not None:
                raise WorkerError(f"ComfyUI exited with code {self._comfy.returncode}")
            try:
                self._api("GET", "/system_stats", timeout=2)
                return
            except (OSError, ComfyRejected):
                time.sleep(1.0)
        raise WorkerError("ComfyUI did not start in 10 minutes.")

    def _comfy_log_tail(self, limit: int = 2000) -> str:
        try:
            return (self.root / "comfyui.log").read_bytes()[-limit:].decode("utf-8", errors="replace")
        except OSError:
            return ""

    @staticmethod
    def _gpu_name() -> str | None:
        try:
            result = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                                    capture_output=True, text=True, timeout=10, check=False)
            return result.stdout.strip() or None
        except OSError:
            return None

    # --- ComfyUI HTTP -----------------------------------------------------------------

    def _api(self, method: str, path: str, payload: Any = None, *, timeout: float = 30.0) -> Any:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail: Any = json.loads(raw)
            except json.JSONDecodeError:
                detail = raw
            raise ComfyRejected(exc.code, detail) from exc
        return json.loads(body) if body else {}

    # --- relay ----------------------------------------------------------------------

    def _relay(self) -> None:
        while not self._stop.wait(0.5):
            try:
                self._scan_inbox()
                self._check_comfyui()
            except Exception as exc:
                self.log.emit("error", message=f"Relay: {exc}")

    def _scan_inbox(self) -> None:
        for path in sorted(self.inbox.glob("*.job.json")):
            job_id = path.name[: -len(".job.json")]
            if job_id in self.jobs:
                continue
            try:
                job = parse_job(path.read_text(encoding="utf-8"))
            except (OSError, WorkerError) as exc:
                # A file still being written is retried; a broken one fails after a while.
                if time.time() - path.stat().st_mtime > 30:
                    self._fail(job_id, f"Bad job file: {exc}", known=False)
                    path.unlink(missing_ok=True)
                continue
            if job["id"] != job_id:
                self._fail(job_id, "Job id does not match its file name.", known=False)
                path.unlink(missing_ok=True)
                continue
            with self._lock:
                self.jobs[job_id] = {"state": "received", "job": job, "received_at": time.time()}
            self.touch()
            self.log.emit("job_received", job=job_id)
            self._prep.submit(self._prepare_and_queue, job_id)
        for path in self.inbox.glob("*.cancel"):
            if marker_ready(path):
                path.unlink(missing_ok=True)
                self._cancel(path.name[: -len(".cancel")])
        for path in self.inbox.glob("*.collected"):
            if marker_ready(path):
                path.unlink(missing_ok=True)
                self._collect(path.name[: -len(".collected")])
        settings = self.inbox / "settings.json"
        if settings.is_file() and marker_ready(settings):
            try:
                self.set_idle(json.loads(settings.read_text(encoding="utf-8")).get("idle_seconds"))
                settings.unlink(missing_ok=True)
                self.log.emit("settings", idle_seconds=self.idle_seconds)
            except (OSError, ValueError, AttributeError):
                if time.time() - settings.stat().st_mtime > 30:
                    settings.unlink(missing_ok=True)

    def _state(self, job_id: str, state: str) -> None:
        with self._lock:
            if job_id in self.jobs:
                self.jobs[job_id]["state"] = state
        self.touch()

    def _fail(self, job_id: str, message: str, *, error: Any = None, known: bool = True) -> None:
        if known:
            self._state(job_id, "failed")
        self.log.emit("job_failed", job=job_id, message=message, error=error)

    def _prepare_and_queue(self, job_id: str) -> None:
        job = self.jobs[job_id]["job"]
        try:
            self._state(job_id, "preparing")
            # All models of a job at once: the cold start waits only for the largest file.
            with ThreadPoolExecutor(max_workers=4, thread_name_prefix="mediastudio-download") as pool:
                for future in [pool.submit(self._ensure_resource, item, job_id) for item in job["resources"]]:
                    future.result()
            if self.jobs[job_id]["state"] == "cancelled":
                return
            target_dir = self.comfy_dir / "input" / "mediastudio"
            target_dir.mkdir(parents=True, exist_ok=True)
            for name in job["inputs"]:
                source = self.inputs / name
                if not source.is_file():
                    raise WorkerError(f"Input {name} was not uploaded.")
                shutil.copyfile(source, target_dir / name)
        except Exception as exc:
            self._fail(job_id, str(exc))
            return
        while not self.ready.wait(timeout=1.0):
            if self.stage == "failed" or self._stop.is_set():
                self._fail(job_id, "ComfyUI could not start on the runtime.")
                return
        if self.jobs[job_id]["state"] == "cancelled":
            return
        try:
            response = self._api("POST", "/prompt", {
                "prompt": job["workflow"], "client_id": self.client_id, "prompt_id": job_id,
                "extra_data": job["extra_data"],
            })
        except ComfyRejected as exc:
            self._fail(job_id, "ComfyUI rejected the workflow.", error=exc.detail)
            return
        except OSError as exc:
            self._fail(job_id, f"ComfyUI is not reachable: {exc}")
            return
        self._state(job_id, "queued")
        self.log.emit("job_queued", job=job_id, number=response.get("number"))

    def _file_lock(self, key: str) -> threading.Lock:
        with self._lock:
            return self._file_locks.setdefault(key, threading.Lock())

    def _ensure_resource(self, resource: dict[str, Any], job_id: str) -> None:
        target = self.comfy_dir / "models" / resource["folder"] / resource["filename"]
        with self._file_lock(str(target)):
            if target.is_file():
                self._cache_model(resource, target, job_id)
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            if self._restore_model(resource, target, job_id):
                return
            started = time.time()
            self.log.emit("download", job=job_id, file=resource["filename"], state="started")
            hf = hf_parts(resource["url"])
            if hf is not None and self._hf_download(hf, target):
                if resource["sha256"] and _sha256_file(target) != resource["sha256"]:
                    target.unlink(missing_ok=True)
                    raise WorkerError(f"{resource['filename']} does not match its sha256.")
            else:
                self._http_download(resource, target, job_id)
            size = target.stat().st_size
            seconds = max(0.01, time.time() - started)
            self.log.emit("download", job=job_id, file=resource["filename"], state="done", bytes=size,
                          seconds=round(seconds, 1), mb_per_s=round(size / 1e6 / seconds))
            self._cache_model(resource, target, job_id)

    def _cache_paths(self, resource: dict[str, Any]) -> tuple[Path, Path] | None:
        if self.model_cache_dir is None:
            return None
        key = resource.get("cache_key") or resource.get("sha256")
        if not key:
            key = hashlib.sha256(resource["url"].encode()).hexdigest()
        folder = self.model_cache_dir / resource["folder"] / key
        target = folder / resource["filename"]
        return target, folder / "integrity.json"

    def _copy_model(self, source: Path, target: Path, expected: str | None) -> str:
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + f".{uuid.uuid4().hex}.part")
        digest = hashlib.sha256()
        try:
            with source.open("rb") as reader, partial.open("xb") as writer:
                while chunk := reader.read(DOWNLOAD_CHUNK):
                    if self._stop.is_set():
                        raise WorkerError("model cache copy cancelled")
                    writer.write(chunk)
                    digest.update(chunk)
                    self.touch()
                writer.flush()
                os.fsync(writer.fileno())
            actual = digest.hexdigest()
            if expected and actual != expected:
                raise WorkerError("model cache checksum mismatch")
            if partial.stat().st_size == 0:
                raise WorkerError("model cache file is empty")
            os.replace(partial, target)
            return actual
        finally:
            partial.unlink(missing_ok=True)

    def _restore_model(self, resource: dict[str, Any], target: Path, job_id: str) -> bool:
        paths = self._cache_paths(resource)
        if paths is None:
            return False
        source, manifest = paths
        if not manifest.is_file() or not source.is_file():
            return False
        try:
            integrity = json.loads(manifest.read_text(encoding="utf-8"))
            checksum = integrity["sha256"]
            if not isinstance(checksum, str) or not _SHA256.fullmatch(checksum):
                raise WorkerError("invalid model cache checksum")
            if resource.get("sha256") and resource["sha256"] != checksum:
                raise WorkerError("model cache version mismatch")
            if source.stat().st_size != integrity["bytes"]:
                raise WorkerError("model cache size mismatch")
            self.log.emit("model_cache", job=job_id, file=resource["filename"], state="restoring")
            self._copy_model(source, target, checksum)
            self._cached_models.add(str(source))
            self.log.emit("model_cache", job=job_id, file=resource["filename"], state="restored")
            return True
        except (OSError, ValueError, KeyError, TypeError, WorkerError) as exc:
            self.log.emit("model_cache", job=job_id, file=resource["filename"], state="warning", message=str(exc))
            return False

    def _cache_model(self, resource: dict[str, Any], source: Path, job_id: str) -> None:
        paths = self._cache_paths(resource)
        if paths is None:
            return
        target, manifest = paths
        if str(target) in self._cached_models:
            return
        try:
            if target.is_file() and manifest.is_file():
                try:
                    integrity = json.loads(manifest.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    integrity = {}
                if (isinstance(integrity, dict) and integrity.get("bytes") == target.stat().st_size == source.stat().st_size
                        and _sha256_file(target) == integrity.get("sha256")
                        and (not resource.get("sha256") or integrity.get("sha256") == resource["sha256"])):
                    self._cached_models.add(str(target))
                    return
            self.log.emit("model_cache", job=job_id, file=resource["filename"], state="saving")
            checksum = self._copy_model(source, target, resource.get("sha256"))
            temporary = manifest.with_name(f"integrity.{uuid.uuid4().hex}.part")
            try:
                temporary.write_text(json.dumps({"sha256": checksum, "bytes": target.stat().st_size}), encoding="utf-8")
                os.replace(temporary, manifest)
            finally:
                temporary.unlink(missing_ok=True)
            self._cached_models.add(str(target))
            self.log.emit("model_cache", job=job_id, file=resource["filename"], state="saved")
        except (OSError, ValueError, TypeError, WorkerError) as exc:
            self.log.emit("model_cache", job=job_id, file=resource["filename"], state="warning", message=str(exc))

    def _hf_download(self, parts: tuple[str, str, str], target: Path) -> bool:
        try:
            hub = importlib.import_module("huggingface_hub")
        except ImportError:
            return False
        repo, revision, path = parts
        local = hub.hf_hub_download(repo, path, revision=revision, local_dir=str(self.root / "hf" / repo))
        os.replace(local, target)
        return True

    def _http_download(self, resource: dict[str, Any], target: Path, job_id: str) -> None:
        partial = target.with_name(target.name + ".part")
        digest = hashlib.sha256()
        request = urllib.request.Request(resource["url"], headers={"User-Agent": "mediastudio-colab-worker"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as file:
                total = int(response.headers.get("Content-Length") or 0) or None
                done, reported = 0, time.monotonic()
                while chunk := response.read(DOWNLOAD_CHUNK):
                    file.write(chunk)
                    digest.update(chunk)
                    done += len(chunk)
                    if time.monotonic() - reported >= PROGRESS_EVERY_SECONDS:
                        reported = time.monotonic()
                        self.touch()
                        self.log.emit("download", job=job_id, file=resource["filename"], state="progress",
                                      done=done, total=total)
        except urllib.error.HTTPError as exc:
            partial.unlink(missing_ok=True)
            raise WorkerError(f"Download of {resource['filename']} failed: HTTP {exc.code}") from exc
        except OSError:
            partial.unlink(missing_ok=True)
            raise
        if resource["sha256"] and digest.hexdigest() != resource["sha256"]:
            partial.unlink(missing_ok=True)
            raise WorkerError(f"{resource['filename']} does not match its sha256.")
        os.replace(partial, target)

    # --- ComfyUI events ---------------------------------------------------------------

    def _comfy_events(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                ws = _MiniWebSocket("127.0.0.1", self.port, f"/ws?clientId={self.client_id}")
            except OSError:
                time.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            backoff = 1.0
            ws.sock.settimeout(5.0)
            try:
                while not self._stop.is_set():
                    try:
                        text = ws.recv_text()
                    except TimeoutError:
                        self._poll_running()
                        continue
                    if text:
                        self._on_comfy_message(text)
            except OSError:
                pass
            finally:
                ws.close()

    def _on_comfy_message(self, text: str) -> None:
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            return
        kind = message.get("type")
        data = message.get("data") if isinstance(message.get("data"), dict) else {}
        job_id = str(data.get("prompt_id") or "")
        if kind not in RELAYED_COMFY_EVENTS or job_id not in self.jobs:
            return
        self.touch()
        if kind == "execution_start":
            self._state(job_id, "running")
        self.log.emit("comfy", job=job_id, msg=message)
        ended = kind in {"execution_success", "execution_error", "execution_interrupted"}
        if ended or (kind == "executing" and data.get("node") is None):
            self._finish_soon(job_id)

    def _poll_running(self) -> None:
        """While the socket is quiet, a job ComfyUI finished without a message still gets done."""
        with self._lock:
            waiting = [job_id for job_id, job in self.jobs.items() if job["state"] in {"queued", "running"}]
        for job_id in waiting:
            try:
                if job_id in self._api("GET", f"/history/{job_id}", timeout=10):
                    self._finish_soon(job_id)
            except (OSError, ComfyRejected):
                return

    def _finish_soon(self, job_id: str) -> None:
        with self._lock:
            job = self.jobs.get(job_id)
            if job is None or job["state"] in FINAL_STATES or job.get("finishing"):
                return
            job["finishing"] = True
        threading.Thread(target=self._finish, args=(job_id,), daemon=True, name="mediastudio-finish").start()

    def _finish(self, job_id: str) -> None:
        item: dict[str, Any] | None = None
        for _ in range(20):
            try:
                item = self._api("GET", f"/history/{job_id}", timeout=10).get(job_id)
            except (OSError, ComfyRejected):
                item = None
            if item:
                break
            time.sleep(0.25)
        if not item:
            self._fail(job_id, "ComfyUI finished the job but kept no history for it.")
            return
        status = item.get("status") if isinstance(item.get("status"), dict) else {}
        messages = status.get("messages") or []
        interrupted = any(isinstance(m, list) and m and m[0] == "execution_interrupted" for m in messages)
        error = next((m[1] for m in messages if isinstance(m, list) and len(m) > 1 and m[0] == "execution_error"), None)
        if status.get("status_str") != "success":
            if interrupted:
                self._state(job_id, "cancelled")
                self.log.emit("job_cancelled", job=job_id)
            else:
                self._fail(job_id, "The workflow failed in ComfyUI.", error=error or status)
            return
        files = []
        target = self.outbox / job_id
        target.mkdir(parents=True, exist_ok=True)
        for item_file in output_files(item.get("outputs") or {}):
            base = self.comfy_dir / ("temp" if item_file.get("type") == "temp" else "output")
            source = base / str(item_file.get("subfolder") or "") / str(item_file["filename"])
            name = safe_name(Path(str(item_file["filename"])).name, label="output file")
            if source.is_file():
                shutil.copyfile(source, target / name)
                files.append({**item_file, "path": str(target / name), "bytes": (target / name).stat().st_size})
        self._state(job_id, "done")
        self.log.emit("job_done", job=job_id, outputs=item.get("outputs") or {}, files=files, status=status)

    # --- cancel and cleanup -----------------------------------------------------------

    def _cancel(self, job_id: str) -> None:
        with self._lock:
            job = self.jobs.get(job_id)
            if job is None or job["state"] in FINAL_STATES:
                return
            queued = job["state"] in {"queued", "running"}
            if not queued:
                job["state"] = "cancelled"
        self.touch()
        if not queued:
            self.log.emit("job_cancelled", job=job_id)
            return
        try:
            self._api("POST", "/queue", {"delete": [job_id]})
            queue = self._api("GET", "/queue")
            running = any(len(entry) > 1 and entry[1] == job_id for entry in queue.get("queue_running", []))
            pending = any(len(entry) > 1 and entry[1] == job_id for entry in queue.get("queue_pending", []))
            if running:
                self._api("POST", "/interrupt", {"prompt_id": job_id})
            elif not pending:
                self._state(job_id, "cancelled")
                self.log.emit("job_cancelled", job=job_id)
        except (OSError, ComfyRejected) as exc:
            self.log.emit("error", message=f"Cancel {job_id}: {exc}")

    def _collect(self, job_id: str) -> None:
        with self._lock:
            job = self.jobs.pop(job_id, None)
            # A batch shares one uploaded photo: it stays while another job still uses it.
            in_use = {name for other in self.jobs.values() for name in other["job"]["inputs"]}
        shutil.rmtree(self.outbox / job_id, ignore_errors=True)
        (self.inbox / f"{job_id}.job.json").unlink(missing_ok=True)
        if job is not None:
            for name in job["job"]["inputs"]:
                if name in in_use:
                    continue
                (self.inputs / name).unlink(missing_ok=True)
                (self.comfy_dir / "input" / "mediastudio" / name).unlink(missing_ok=True)
        try:
            item = self._api("GET", f"/history/{job_id}", timeout=10).get(job_id) or {}
            for item_file in output_files(item.get("outputs") or {}):
                base = self.comfy_dir / ("temp" if item_file.get("type") == "temp" else "output")
                (base / str(item_file.get("subfolder") or "") / str(item_file["filename"])).unlink(missing_ok=True)
            self._api("POST", "/history", {"delete": [job_id]})
        except (OSError, ComfyRejected):
            pass
        self.touch()
        self.log.emit("job_collected", job=job_id)

    def _check_comfyui(self) -> None:
        """Restart a ComfyUI that stopped after boot (boot itself reports its own failure)."""
        if self.stage != "ready" or self._comfy is None or self._comfy.poll() is None or self._stop.is_set():
            return
        self.ready.clear()
        tail = self._comfy_log_tail()
        with self._lock:
            lost = [job_id for job_id, job in self.jobs.items() if job["state"] in {"queued", "running"}]
        for job_id in lost:
            self._fail(job_id, "ComfyUI stopped while the job ran.", error={"log_tail": tail})
        if self._comfy_restarts >= 2:
            self.stage = "failed"
            self.log.emit("boot_failed", message="ComfyUI keeps stopping.", log_tail=tail)
            self._comfy = None
            return
        self._comfy_restarts += 1
        self.log.emit("comfy_restart", code=self._comfy.returncode, log_tail=tail)
        try:
            self._start_comfyui()
            self.ready.set()
        except WorkerError as exc:
            self.stage = "failed"
            self.log.emit("boot_failed", message=str(exc), log_tail=self._comfy_log_tail())


class ComfyRejected(RuntimeError):
    def __init__(self, status: int, detail: Any):
        self.status, self.detail = status, detail
        super().__init__(f"ComfyUI answered HTTP {status}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(DOWNLOAD_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _kernel_worker() -> Worker:
    """The worker already living in this kernel when it is the same version, else a new one."""
    current = globals().get("MEDIASTUDIO_WORKER")
    if current is not None and getattr(current, "version", None) == WORKER_VERSION:
        return current
    if current is not None and hasattr(current, "shutdown"):
        current.shutdown()
    return Worker()


if __name__ == "__main__":
    MEDIASTUDIO_WORKER = _kernel_worker()
