"""MediaStudio's side of a Colab runtime: start it, stream its events, send jobs, stop it when idle.

One ``ColabRuntime`` per MediaStudio process. It allocates a runtime with the Colab CLI, defines the
worker (``colab_worker.py``) in its kernel, boots it and keeps one ``attach`` stream open.
Jobs wait here until the runtime exists, then go up as files; the worker's events update a
local mirror that ``ColabComfyUIClient`` reads, and outputs come down to a cache folder
until Create imports them into the library. A runtime MediaStudio started earlier (MediaStudio restarted
while it ran) is adopted instead of starting a second one.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.comfyui.desktop import comfyui_output_dir
from app.comfyui.progress_monitor import ProgressMonitor
from app.config_store import ConfigStore
from app.model_sources.tokens import civitai_token

from .colab_cli import ColabCLI, ColabCLIError
from .colab_worker import ATTACH_END_PREFIX, EVENT_PREFIX

logger = logging.getLogger(__name__)

WORKER_SOURCE = Path(__file__).with_name("colab_worker.py")
COMFYUI_PIN = {
    "repo": "https://github.com/comfyanonymous/ComfyUI.git",
    "commit": "e8665ca8e4089ab917567cdb491308e1397663d4",  # 2026-10-11, checked with Krea2 on G4 and L4
}
SESSION_PREFIX = "mediastudio-"
REMOTE_ROOT = "/content/mediastudio"
ATTACH_SECONDS = 900
CONTROL_TICK_SECONDS = 2.0
KEEP_FINISHED_SECONDS = 6 * 3600
# How often to look for a runtime whose start failed half-way (each look is a CLI call).
UNCONFIRMED_CHECK_SECONDS = 60.0
# Failures where Colab certainly started nothing.
REFUSED_CODES = {"gpu_rejected", "allocation_refused"}
ACTIVE_STATES = {"waiting", "sent", "received", "preparing", "queued", "running", "collecting"}
DRIVE_AUTH_TIMEOUT_SECONDS = 300

LIVE_STATES = {"allocating", "booting", "ready"}


class RelayedProgressMonitor(ProgressMonitor):
    """A progress monitor fed by the worker's relayed ComfyUI events, without a socket."""

    def __init__(self) -> None:
        super().__init__("colab", 0)
        self.client_id = "mediastudio-colab"

    def ensure_connected(self, timeout: float = 2.0) -> bool:
        return True


@dataclass
class RemoteJob:
    prompt_id: str
    workflow: dict[str, Any]
    extra_data: dict[str, Any] = field(default_factory=dict)
    inputs: list[str] = field(default_factory=list)
    resources: list[dict[str, Any]] = field(default_factory=list)
    state: str = "waiting"
    outputs: dict[str, Any] = field(default_factory=dict)
    files: dict[str, Path] = field(default_factory=dict)
    error: Any = None
    downloads: dict[str, dict[str, Any]] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancel_requested: bool = False


def pid_alive(pid: Any) -> bool:
    """Whether a process with this id runs now (Windows: its exit code is still pending)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
            return bool(ok) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def output_key(subfolder: Any, filename: Any) -> str:
    return f"{subfolder or ''}/{filename}"


_COMFY_FILENAME = re.compile(r"^(?P<prefix>.+)_\d{5,}_(?P<ext>\.[A-Za-z0-9]+)$")


def rename_outputs(outputs: dict[str, Any], renamed: dict[str, str]) -> dict[str, Any]:
    """ComfyUI outputs with the files that were saved under another name renamed."""
    if not renamed:
        return outputs
    result: dict[str, Any] = {}
    for node_id, node_outputs in outputs.items():
        if not isinstance(node_outputs, dict):
            result[node_id] = node_outputs
            continue
        result[node_id] = {
            media_key: [
                {**item, "filename": renamed.get(output_key(item.get("subfolder"), item.get("filename")), item.get("filename"))}
                if isinstance(item, dict) else item
                for item in items
            ] if isinstance(items, list) else items
            for media_key, items in node_outputs.items()
        }
    return result


def save_to_output(output_dir: Path, subfolder: str, filename: str, source: Path) -> Path:
    """Copy a result into ComfyUI's output folder under the next free name, as ComfyUI names it.

    The VM restarts its own counter for every job, so its file names are not reused here.
    """
    root = output_dir.resolve()
    folder = (root / subfolder).resolve() if subfolder else root
    if folder != root and root not in folder.parents:
        raise ValueError(f"The output subfolder leaves the output folder: {subfolder}")
    folder.mkdir(parents=True, exist_ok=True)
    name = Path(filename).name
    match = _COMFY_FILENAME.match(name)
    prefix, ext = (match["prefix"], match["ext"]) if match else (Path(name).stem, Path(name).suffix)
    taken = re.compile(re.escape(prefix) + r"_(\d+)_" + re.escape(ext) + "$", re.IGNORECASE)
    counter = max((int(found[1]) for item in folder.iterdir() if (found := taken.match(item.name))), default=0) + 1
    data = source.read_bytes()
    while True:
        target = folder / f"{prefix}_{counter:05}_{ext}"
        try:
            with target.open("xb") as handle:
                handle.write(data)
            return target
        except FileExistsError:
            counter += 1


OUTPUT_JOB_KEY = "mediastudio_job"


def tag_outputs(outputs: dict[str, Any], prompt_id: str) -> dict[str, Any]:
    """ComfyUI outputs with each file marked by its job, so a download finds that job's file."""
    tagged: dict[str, Any] = {}
    for node_id, node_outputs in outputs.items():
        if not isinstance(node_outputs, dict):
            tagged[node_id] = node_outputs
            continue
        tagged[node_id] = {
            media_key: [
                {**item, OUTPUT_JOB_KEY: prompt_id} if isinstance(item, dict) else item for item in items
            ] if isinstance(items, list) else items
            for media_key, items in node_outputs.items()
        }
    return tagged


def signed_civitai_url(url: str, token: str, *, opener: Any = None) -> str:
    """Ask Civitai for the temporary signed file link without downloading anything.

    The user's token goes only to Civitai; the signed link that comes back (a storage URL
    with its own short-lived authorization) is what the remote runtime downloads.
    """

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if token and not any(key == "token" for key, _ in query):
        query.append(("token", token))
    request = urllib.request.Request(
        urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query))),
        headers={"User-Agent": "mediastudio", **({"Authorization": f"Bearer {token}"} if token else {})},
        method="GET",
    )
    opener = opener or urllib.request.build_opener(_NoRedirect)
    try:
        response = opener.open(request, timeout=30)
        response.close()
    except urllib.error.HTTPError as exc:
        location = exc.headers.get("Location") if exc.code in {301, 302, 303, 307, 308} else None
        if location:
            if token and token in location:
                raise ColabCLIError("Civitai returned a link that carries the token; refusing to send it.") from exc
            return location
        if exc.code in {401, 403}:
            raise ColabCLIError(
                "Civitai needs your API key for this model. Add it in Integrations › Model sources.",
                code="civitai_token_required",
            ) from exc
        raise ColabCLIError(f"Civitai answered HTTP {exc.code} for {parsed.path}.", code="civitai_failed") from exc
    raise ColabCLIError("Civitai did not return a download link.", code="civitai_failed")


class ColabRuntime:
    def __init__(self, store: ConfigStore, *, cache_dir: Path, cli: ColabCLI | None = None):
        self.store = store
        self.cli = cli or ColabCLI()
        self.cache_dir = Path(cache_dir)
        self.monitor = RelayedProgressMonitor()
        self.state = "off"
        self.name: str | None = None
        self.gpu: str | None = None
        self.gpu_name: str | None = None
        self.drive_auth_url: str | None = None
        self.drive_cache_state = "off"
        self._drive_process: subprocess.Popen[bytes] | None = None
        self.boot_stage: str | None = None
        self.error: dict[str, Any] | None = None
        self.started_at: float | None = None
        self.ready_at: float | None = None
        self.images_done = 0
        self.last_activity = time.time()
        self.jobs: dict[str, RemoteJob] = {}
        self.vm_files: set[str] = set()
        self._inputs: dict[str, bytes] = {}
        self._outbox: list[tuple[str, str]] = []  # markers to upload: (remote name, reason)
        self._sent_idle_seconds: int | None = None
        self._last_seq = 0
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._closed = threading.Event()
        self._downloads = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mediastudio-colab-download")
        self._stream_process: subprocess.Popen[bytes] | None = None
        self._stream_thread: threading.Thread | None = None
        self._adopt_checked = False
        self._unconfirmed_checked_at = float("-inf")
        threading.Thread(target=self._control, daemon=True, name="mediastudio-colab-control").start()

    # --- what routes call ---------------------------------------------------------

    def status(self) -> dict[str, Any]:
        with self._lock:
            active = [job for job in self.jobs.values() if job.state in ACTIVE_STATES]
            idle_minutes = self.store.remote_settings()["colab"]["idle_minutes"]
            stops_in = None
            if self.state == "ready" and not active:
                stops_in = max(0, round(idle_minutes * 60 - (time.time() - self.last_activity)))
            return {
                "state": self.state,
                "name": self.name,
                "gpu": self.gpu,
                "gpu_name": self.gpu_name,
                "model_cache": {"enabled": self.store.remote_settings()["colab"]["model_cache"],
                                "state": self.drive_cache_state, "auth_url": self.drive_auth_url},
                "boot_stage": self.boot_stage,
                "error": self.error,
                "started_at": self.started_at,
                "ready_at": self.ready_at,
                "active_jobs": len(active),
                "images_done": self.images_done,
                "idle_minutes": idle_minutes,
                "stops_in_seconds": stops_in,
            }

    def ensure_started(self) -> None:
        with self._lock:
            if self.state in {"off", "error"}:
                self.state, self.error, self.boot_stage = "allocating", None, None
        self._wake.set()

    def stash_input(self, name: str, data: bytes) -> None:
        with self._lock:
            self._inputs[name] = data

    def stashed_inputs(self) -> set[str]:
        with self._lock:
            return set(self._inputs)

    def submit(self, job: RemoteJob) -> None:
        with self._lock:
            self.jobs[job.prompt_id] = job
            self.last_activity = time.time()
        self.monitor.track(job.prompt_id, job.workflow)
        self.ensure_started()

    def cancel(self, prompt_id: str) -> None:
        with self._lock:
            job = self.jobs.get(prompt_id)
            if job is None or job.state not in ACTIVE_STATES:
                return
            if job.state == "waiting":
                self._finish_job(job, "cancelled")
                return
            job.cancel_requested = True
            self._outbox.append((f"{prompt_id}.cancel", "cancel"))
        self._wake.set()

    def close(self) -> None:
        """End this manager's threads (tests); a running runtime is left to its idle stop."""
        self._closed.set()
        self._wake.set()
        if self._drive_process is not None and self._drive_process.poll() is None:
            self._drive_process.terminate()
        if self._stream_process is not None and self._stream_process.poll() is None:
            self._stream_process.kill()

    def stop(self, reason: str = "user") -> None:
        with self._lock:
            if self.state not in LIVE_STATES:
                return
        self._stop_runtime(reason)

    def job_snapshot(self, prompt_id: str) -> dict[str, Any] | None:
        """The job in the shape ComfyUIClient.get_job returns."""
        with self._lock:
            job = self.jobs.get(prompt_id)
            if job is None:
                return None
            if job.state == "done":
                return {"id": prompt_id, "status": "completed", "outputs": job.outputs,
                        "workflow": {"prompt": job.workflow} if job.workflow else None}
            if job.state == "failed":
                return {"id": prompt_id, "status": "failed", "execution_error": job.error or {"message": "The job failed."}}
            if job.state == "cancelled":
                return {"id": prompt_id, "status": "cancelled", "execution_error": {"message": "Cancelled."}}
            if job.state == "running":
                return {"id": prompt_id, "status": "in_progress"}
            return {"id": prompt_id, "status": "pending", "queue_position": None}

    def run_details(self, prompt_id: str) -> dict[str, Any] | None:
        """What a waiting job is waiting for: the runtime starting or its models downloading."""
        with self._lock:
            job = self.jobs.get(prompt_id)
            if job is None:
                return None
            downloads = {
                name: item for name, item in job.downloads.items() if item.get("state") != "done"
            }
            return {
                "backend": "colab",
                "job_state": job.state,
                "runtime_state": self.state,
                "boot_stage": self.boot_stage,
                "model_cache": {"state": self.drive_cache_state},
                "gpu": self.gpu,
                "downloads": downloads,
                "error": job.error if job.state == "failed" else None,
            }

    def output_bytes(self, output: dict[str, Any]) -> bytes:
        key = output_key(output.get("subfolder"), output.get("filename"))
        with self._lock:
            # The VM empties ComfyUI's output folder after each job, so every job's first
            # image has the same name; only the job's own files are its outputs.
            job = self.jobs.get(str(output.get(OUTPUT_JOB_KEY) or ""))
            path = job.files.get(key) if job is not None else None
        if path is None:
            raise FileNotFoundError(f"Colab output {key} is not in the local cache.")
        return path.read_bytes()

    # --- control loop -------------------------------------------------------------

    def _control(self) -> None:
        while not self._closed.is_set():
            self._wake.wait(CONTROL_TICK_SECONDS)
            if self._closed.is_set():
                return
            self._wake.clear()
            try:
                if not self._adopt_checked:
                    self._adopt_checked = True
                    self._adopt()
                self._sweep_unconfirmed()
                if self.state == "allocating":
                    self._start_runtime()
                if self.state in {"booting", "ready"}:
                    self._send_settings()
                    self._dispatch()
                    self._flush_markers()
                self._idle_check()
                self._prune()
            except Exception:
                logger.exception("Colab runtime control loop failed")

    # --- which runtimes are ours ------------------------------------------------------

    def continue_drive_auth(self) -> None:
        """Resume only the mount process that is waiting for the user's Google approval."""
        with self._lock:
            process = self._drive_process
            if not self.drive_auth_url or process is None or process.poll() is not None or process.stdin is None:
                raise ColabCLIError("no drive authorization is waiting", code="drive_not_waiting")
            try:
                process.stdin.write(b"\n")
                process.stdin.flush()
            except OSError as exc:
                raise ColabCLIError("cannot resume google drive authorization", code="drive_mount_failed") from exc
            self.drive_auth_url = None
            self.drive_cache_state = "mounting"

    def _mount_drive(self, name: str) -> None:
        self.drive_cache_state = "mounting"
        process = self.cli.start_drive_mount(name)
        self._drive_process = process

        def read(stream: Any) -> None:
            for raw in iter(stream.readline, b""):
                line = raw.decode("utf-8", errors="replace").strip()
                if "Drive Authorization needed" in line:
                    self.drive_cache_state = "authorizing"
                if self.drive_cache_state == "authorizing" and line.startswith("https://"):
                    parsed = urllib.parse.urlparse(line)
                    if parsed.hostname in {"accounts.google.com", "colab.research.google.com"}:
                        with self._lock:
                            self.drive_auth_url = line

        readers = [threading.Thread(target=read, args=(stream,), daemon=True, name="mediastudio-drive-mount")
                   for stream in (process.stdout, process.stderr) if stream is not None]
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + DRIVE_AUTH_TIMEOUT_SECONDS
        try:
            while process.poll() is None:
                if self._closed.wait(0.1) or self.state != "booting":
                    raise ColabCLIError("google drive connection was cancelled", code="drive_mount_failed")
                if time.monotonic() >= deadline:
                    raise ColabCLIError(
                        "google drive access was not confirmed within 5 minutes, open the Google access link and try again",
                        code="drive_auth_timeout",
                    )
            for reader in readers:
                reader.join(timeout=2)
            if process.returncode != 0:
                raise ColabCLIError("google drive could not connect, grant access in Remote GPU and try again",
                                    code="drive_mount_failed")
            # Some CLI releases print a kernel exception but still return zero.
            checked = self.cli.exec_code(name,
                "from pathlib import Path\nassert Path('/content/drive/MyDrive').is_dir(), 'drive mount missing'",
                timeout=30, attempts=1)
            if checked.returncode != 0:
                raise ColabCLIError("google drive mount is unavailable", code="drive_mount_failed")
            self.drive_cache_state = "ready"
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for reader in readers:
                reader.join(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
            self._drive_process = None
            self.drive_auth_url = None

    @property
    def _records(self) -> Path:
        return self.cache_dir / "runtimes"

    def _record_owner(self, name: str, *, unconfirmed: bool = False) -> None:
        """Note that this process runs ``name``; another MediaStudio process leaves it alone.

        ``unconfirmed`` marks a runtime asked for but not reported started: when the start
        fails half-way, Colab may still have created it, and it must not run unseen.
        """
        self._records.mkdir(parents=True, exist_ok=True)
        record = {"name": name, "pid": os.getpid(), "gpu": self.gpu, "recorded_at": time.time()}
        if unconfirmed:
            record["unconfirmed"] = True
        (self._records / f"{name}.json").write_text(json.dumps(record), encoding="utf-8")

    def _read_records(self) -> list[dict[str, Any]]:
        records = []
        for path in sorted(self._records.glob("*.json")) if self._records.is_dir() else []:
            try:
                records.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
        return records

    def _sweep_unconfirmed(self, *, force: bool = False) -> None:
        """Stop runtimes whose start failed half-way; forget them once Colab no longer lists them."""
        now = time.monotonic()
        if not force and now - self._unconfirmed_checked_at < UNCONFIRMED_CHECK_SECONDS:
            return
        records = [
            record for record in self._read_records()
            if record.get("unconfirmed") and record.get("name") != self.name
            and (record.get("pid") == os.getpid() or not pid_alive(record.get("pid")))
        ]
        if not records:
            return
        self._unconfirmed_checked_at = now
        try:
            alive = {item.name for item in self.cli.sessions()}
        except ColabCLIError:
            return  # Colab is unreachable; look again later.
        for record in records:
            name = str(record.get("name"))
            if name in alive:
                logger.warning("Stopping Colab runtime %s: it started although its start was reported as failed", name)
                self._stop_quietly(name)
            else:
                self._forget_owner(name)

    def _forget_owner(self, name: str | None) -> None:
        if name:
            (self._records / f"{name}.json").unlink(missing_ok=True)

    def _adopt(self) -> None:
        """Take over a runtime that this MediaStudio started before it restarted.

        Only runtimes recorded here are candidates, and only when the process that
        recorded them has ended: a second MediaStudio running now (the desktop app next to a
        dev server, say) keeps its own runtime, and runtimes started by hand are left alone.
        """
        records = [
            record for record in self._read_records()
            if not record.get("unconfirmed")
            and (record.get("pid") == os.getpid() or not pid_alive(record.get("pid")))
        ]
        if not records:
            return
        try:
            alive = {item.name: item for item in self.cli.sessions()}
        except ColabCLIError:
            return
        for record in records:
            session = alive.get(str(record.get("name")))
            if session is None:
                self._forget_owner(str(record.get("name")))
                continue
            with self._lock:
                self.name, self.gpu, self.state = session.name, session.hardware, "booting"
                self.started_at = time.time()
                self._last_seq = 0
            self._record_owner(session.name)
            logger.info("Adopting Colab runtime %s (%s)", session.name, session.hardware)
            self._start_stream()
            return

    def _fail_runtime(self, message: str, code: str) -> None:
        with self._lock:
            self.state = "error"
            self.error = {"message": message, "code": code}
            for job in self.jobs.values():
                if job.state in ACTIVE_STATES:
                    job.error = {"message": message, "code": code}
                    self._finish_job(job, "failed")

    def _start_runtime(self) -> None:
        settings = self.store.remote_settings()["colab"]
        name = f"{SESSION_PREFIX}{uuid.uuid4().hex[:8]}"
        with self._lock:
            self.gpu, self.boot_stage, self.started_at, self.ready_at = settings["gpu"], "allocating", time.time(), None
        self._record_owner(name, unconfirmed=True)
        try:
            self.cli.new(name, settings["gpu"])
        except ColabCLIError as exc:
            self._fail_runtime(str(exc), exc.code)
            if exc.code in REFUSED_CODES:
                self._forget_owner(name)
            else:
                self._sweep_unconfirmed(force=True)
            return
        with self._lock:
            self.name, self._last_seq, self.vm_files = name, 0, set()
        self._record_owner(name)
        try:
            if settings["model_cache"]:
                with self._lock:
                    self.state, self.boot_stage = "booting", "drive"
                self._mount_drive(name)
                self.boot_stage = "comfyui"
            defined = self.cli.exec_code(name, WORKER_SOURCE.read_text(encoding="utf-8"), timeout=180)
            if defined.returncode != 0:
                raise ColabCLIError(f"The worker could not start: {defined.stderr.strip()[-300:]}", code="worker_failed")
            spec = {"comfyui": COMFYUI_PIN, "custom_nodes": self._custom_nodes(),
                    "idle_seconds": settings["idle_minutes"] * 60,
                    "model_cache_dir": "/content/drive/MyDrive/VEIL/model-cache" if settings["model_cache"] else None}
            booted = self.cli.exec_code(name, f"import json\nMEDIASTUDIO_WORKER.boot(json.loads({json.dumps(json.dumps(spec))}))", timeout=120)
            if booted.returncode != 0:
                raise ColabCLIError(f"The worker did not boot: {booted.stderr.strip()[-300:]}", code="worker_failed")
        except ColabCLIError as exc:
            if self.boot_stage == "drive":
                self.drive_cache_state = "error"
            self._fail_runtime(str(exc), exc.code)
            self._stop_quietly(name)
            self._forget_owner(name)
            return
        with self._lock:
            self.state, self.boot_stage = "booting", "comfyui"
            self._sent_idle_seconds = settings["idle_minutes"] * 60
        self._start_stream()

    @staticmethod
    def _custom_nodes() -> list[dict[str, Any]]:
        from app.comfyui.simple_profiles import APPROVED_PROFILES

        packs: dict[str, dict[str, Any]] = {}
        for profile in APPROVED_PROFILES.values():
            for pack in profile.custom_nodes:
                packs[pack.id] = dataclasses.asdict(pack)
        return list(packs.values())

    def _stop_quietly(self, name: str) -> None:
        try:
            self.cli.stop(name)
        except ColabCLIError:
            logger.warning("Could not stop Colab runtime %s", name)

    def _stop_runtime(self, reason: str) -> None:
        with self._lock:
            name = self.name
            self.state = "stopping"
        if self._stream_process is not None and self._stream_process.poll() is None:
            self._stream_process.kill()
        if name:
            self._stop_quietly(name)
        self._runtime_gone(f"The Colab runtime stopped ({reason}).")

    def _runtime_gone(self, message: str) -> None:
        self._forget_owner(self.name)
        with self._lock:
            for job in self.jobs.values():
                if job.state in ACTIVE_STATES:
                    job.error = {"message": message, "code": "runtime_stopped"}
                    self._finish_job(job, "failed")
            self.state, self.name, self.boot_stage = "off", None, None
            self.vm_files = set()

    def _send_settings(self) -> None:
        idle_seconds = self.store.remote_settings()["colab"]["idle_minutes"] * 60
        if idle_seconds == self._sent_idle_seconds or not self.name:
            return
        self._upload_bytes(json.dumps({"idle_seconds": idle_seconds}).encode("utf-8"), "settings.json")
        self._sent_idle_seconds = idle_seconds

    def _dispatch(self) -> None:
        with self._lock:
            waiting = [job for job in self.jobs.values() if job.state == "waiting"]
        for job in waiting:
            try:
                for name in job.inputs:
                    data = self._inputs.get(name)
                    if data is None:
                        raise ColabCLIError(f"The photo {name} is no longer here; queue the run again.", code="input_missing")
                    self._upload_bytes(data, f"inputs/{Path(name).name}")
                payload = {
                    "id": job.prompt_id, "client_id": self.monitor.client_id, "workflow": job.workflow,
                    "extra_data": job.extra_data, "inputs": job.inputs, "resources": self._resolved(job.resources),
                }
                self._upload_bytes(json.dumps(payload).encode("utf-8"), f"{job.prompt_id}.job.json")
            except ColabCLIError as exc:
                with self._lock:
                    job.error = {"message": str(exc), "code": exc.code}
                    self._finish_job(job, "failed")
                continue
            with self._lock:
                if job.state == "waiting":
                    job.state = "sent"
                self.last_activity = time.time()

    def _resolved(self, resources: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Models the runtime lacks get a link it can use: Civitai links are signed here."""
        token = civitai_token(self.store)
        resolved = []
        for item in resources:
            url = item["url"]
            host = (urllib.parse.urlparse(url).hostname or "").casefold()
            if item["filename"] not in self.vm_files and (host == "civitai.com" or host.endswith(".civitai.com")):
                url = signed_civitai_url(url, token)
            key = hashlib.sha256((item["folder"] + "/" + item["filename"] + "\n" + item["url"]
                                  + "\n" + (item.get("sha256") or "")).encode()).hexdigest()
            resolved.append({**item, "url": url, "cache_key": key})
        return resolved

    def _flush_markers(self) -> None:
        with self._lock:
            markers, self._outbox = self._outbox, []
        for remote, reason in markers:
            try:
                self._upload_bytes(b"1", remote)
            except ColabCLIError as exc:
                logger.warning("Colab %s marker %s failed: %s", reason, remote, exc)

    def _upload_bytes(self, data: bytes, remote_name: str) -> None:
        if not self.name:
            raise ColabCLIError("The Colab runtime is not running.", code="runtime_stopped")
        staging = self.cache_dir / "upload"
        staging.mkdir(parents=True, exist_ok=True)
        local = staging / f"{uuid.uuid4().hex}-{Path(remote_name).name}"
        local.write_bytes(data)
        try:
            self.cli.upload(self.name, local, f"{REMOTE_ROOT}/inbox/{remote_name}")
        finally:
            local.unlink(missing_ok=True)

    def _idle_check(self) -> None:
        with self._lock:
            if self.state != "ready" or any(job.state in ACTIVE_STATES for job in self.jobs.values()):
                return
            idle_seconds = self.store.remote_settings()["colab"]["idle_minutes"] * 60
            due = time.time() - self.last_activity > idle_seconds
        if due:
            logger.info("Stopping idle Colab runtime %s", self.name)
            self._stop_runtime("idle")

    def _prune(self) -> None:
        now = time.time()
        with self._lock:
            old = [key for key, job in self.jobs.items()
                   if job.finished_at and now - job.finished_at > KEEP_FINISHED_SECONDS]
            for key in old:
                job = self.jobs.pop(key)
                shutil.rmtree(self.cache_dir / key, ignore_errors=True)
                for name in job.inputs:
                    self._inputs.pop(name, None)

    def _finish_job(self, job: RemoteJob, state: str) -> None:
        job.state = state
        job.finished_at = time.time()
        if state == "cancelled":
            self.monitor.handle({"type": "execution_interrupted", "data": {"prompt_id": job.prompt_id}})
        elif state == "failed":
            self.monitor.handle({"type": "execution_error", "data": {"prompt_id": job.prompt_id}})

    # --- event stream -------------------------------------------------------------

    def _start_stream(self) -> None:
        if self._stream_thread is not None and self._stream_thread.is_alive():
            return
        self._stream_thread = threading.Thread(target=self._stream, daemon=True, name="mediastudio-colab-stream")
        self._stream_thread.start()

    def _stream(self) -> None:
        failures = 0
        while self.state in {"booting", "ready"} and self.name and not self._closed.is_set():
            name = self.name
            try:
                process = self.cli.exec_stream(
                    name, f"MEDIASTUDIO_WORKER.attach({self._last_seq}, {ATTACH_SECONDS})", timeout=ATTACH_SECONDS + 120,
                )
            except ColabCLIError as exc:
                failures += 1
                logger.warning("Colab attach could not start: %s", exc)
                time.sleep(min(30, 2 * failures))
                continue
            self._stream_process = process
            ended = False
            assert process.stdout is not None
            for raw in iter(process.stdout.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line.startswith(EVENT_PREFIX):
                    try:
                        self._on_event(json.loads(line[len(EVENT_PREFIX):]))
                    except (json.JSONDecodeError, KeyError, TypeError) as exc:
                        logger.debug("Bad Colab event %r: %s", line[:200], exc)
                elif line.startswith(ATTACH_END_PREFIX):
                    ended = True
            process.wait()
            if self.state not in {"booting", "ready"} or self._closed.is_set():
                return
            if ended:
                failures = 0
                continue
            failures += 1
            if not self._runtime_alive(name):
                self._runtime_gone("The Colab runtime ended.")
                return
            # The stream broke but the runtime lives: free the kernel from the old attach.
            try:
                self._upload_bytes(b"1", "detach")
            except ColabCLIError:
                pass
            time.sleep(min(30, 2 * failures))

    def _runtime_alive(self, name: str) -> bool:
        try:
            return any(item.name == name for item in self.cli.sessions())
        except ColabCLIError:
            return True  # unknown; keep trying

    def _on_event(self, event: dict[str, Any]) -> None:
        seq = int(event.get("seq") or 0)
        if seq <= self._last_seq:
            return
        self._last_seq = seq
        kind = event.get("ev")
        with self._lock:
            self.last_activity = time.time()
            if kind == "boot":
                self.boot_stage = event.get("stage")
            elif kind == "ready":
                self.state, self.boot_stage, self.ready_at = "ready", "ready", time.time()
                self.gpu_name = event.get("gpu")
                if event.get("model_cache") is not None:
                    self.drive_cache_state = "ready" if event["model_cache"] else "off"
            elif kind == "boot_failed":
                self._fail_runtime(f"ComfyUI could not start on Colab: {event.get('message')}", "boot_failed")
            elif kind == "idle_stop":
                self._runtime_gone("The Colab runtime stopped itself after the idle time.")
                return
            job = self._job_for(event)
            if job is None:
                return
            if kind == "job_received":
                job.state = "received" if job.state in {"waiting", "sent"} else job.state
            elif kind == "download":
                job.state = "preparing" if job.state in {"sent", "received"} else job.state
                job.downloads[str(event.get("file"))] = {
                    key: event.get(key) for key in ("state", "done", "total", "bytes", "seconds", "mb_per_s")
                }
                if event.get("state") == "done":
                    self.vm_files.add(str(event.get("file")))
            elif kind == "model_cache":
                self.drive_cache_state = str(event.get("state") or "ready")
            elif kind == "job_queued":
                job.state = "queued" if job.state in {"sent", "received", "preparing"} else job.state
            elif kind == "comfy":
                message = event.get("msg") or {}
                if message.get("type") == "execution_start" and job.state not in {"done", "failed", "cancelled"}:
                    job.state = "running"
                self.monitor.handle(message)
            elif kind == "job_done":
                job.state = "collecting"
                job.outputs = tag_outputs(event.get("outputs") or {}, job.prompt_id)
                self._downloads.submit(self._collect, job.prompt_id, list(event.get("files") or []))
            elif kind == "job_failed":
                job.error = {"message": event.get("message"), **(event.get("error") if isinstance(event.get("error"), dict) else {})}
                self._finish_job(job, "failed")
            elif kind == "job_cancelled":
                self._finish_job(job, "cancelled")

    def _job_for(self, event: dict[str, Any]) -> RemoteJob | None:
        prompt_id = event.get("job")
        if not prompt_id:
            return None
        job = self.jobs.get(str(prompt_id))
        if job is None and event.get("ev") in {"job_done", "job_failed", "job_cancelled", "job_queued", "comfy"}:
            # A job from before MediaStudio restarted: rebuilt so its run can still finish.
            job = self.jobs[str(prompt_id)] = RemoteJob(prompt_id=str(prompt_id), workflow={}, state="sent")
        return job

    def _save_outputs(self, files: list[dict[str, Any]], downloaded: dict[str, Path]) -> dict[str, str]:
        """Results also land in ComfyUI's output folder, as they do when this computer renders.

        Returns the new file name of each saved output by its key, so the library names the
        image as the file in the output folder is named.
        """
        output_dir = comfyui_output_dir(self.store.comfyui_settings())
        if output_dir is None:
            logger.warning("No ComfyUI output folder is known; Colab results stay in the library only")
            return {}
        renamed: dict[str, str] = {}
        for item in files:
            key = output_key(item.get("subfolder"), item.get("filename"))
            local = downloaded.get(key)
            if local is None:
                continue
            try:
                saved = save_to_output(output_dir, str(item.get("subfolder") or ""), str(item["filename"]), local)
            except (OSError, ValueError) as exc:
                logger.warning("Could not save the Colab result %s to %s: %s", item.get("filename"), output_dir, exc)
                continue
            if saved.name != item["filename"]:
                renamed[key] = saved.name
        return renamed

    def _collect(self, prompt_id: str, files: list[dict[str, Any]]) -> None:
        job = self.jobs.get(prompt_id)
        if job is None or self.name is None:
            return
        target = self.cache_dir / prompt_id
        downloaded: dict[str, Path] = {}
        try:
            for item in files:
                local = target / Path(str(item["filename"])).name
                self.cli.download(self.name, str(item["path"]), local)
                downloaded[output_key(item.get("subfolder"), item.get("filename"))] = local
        except ColabCLIError as exc:
            with self._lock:
                job.error = {"message": f"The result could not be downloaded from Colab: {exc}", "code": exc.code}
                self._finish_job(job, "failed")
            return
        renamed = self._save_outputs(files, downloaded)
        with self._lock:
            for key, name in renamed.items():
                downloaded[output_key(key.rsplit("/", 1)[0], name)] = downloaded.pop(key)
            job.outputs = rename_outputs(job.outputs, renamed)
            job.files = downloaded
            job.state = "done"
            job.finished_at = time.time()
            self.images_done += len(downloaded)
            self.last_activity = time.time()
            self._outbox.append((f"{prompt_id}.collected", "collect"))
        self._wake.set()


__all__ = [
    "COMFYUI_PIN",
    "ColabRuntime",
    "RelayedProgressMonitor",
    "RemoteJob",
    "output_key",
    "pid_alive",
    "save_to_output",
    "signed_civitai_url",
]
