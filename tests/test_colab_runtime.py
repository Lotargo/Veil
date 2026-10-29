from __future__ import annotations

import io
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error

import pytest

from app.comfyui.simple_profiles import (
    APPROVED_PROFILES,
    compile_edit_workflow,
    compile_simple_workflow,
)
from app.config_store import ConfigStore
from app.model_sources.tokens import clear_civitai_token, save_civitai_token
from app.remote import colab_runtime
from app.remote.colab_backend import (
    ColabBackend,
    ColabComfyUIClient,
    job_inputs,
    job_resources,
)
from app.remote.colab_cli import ColabCLIError, ColabSession
from app.remote.colab_runtime import ColabRuntime, save_to_output, signed_civitai_url
from app.remote.colab_worker import ATTACH_END_PREFIX, EVENT_PREFIX

PROFILE = APPROVED_PROFILES["krea2_moody_v40"]
PNG = b"\x89PNG\r\n\x1a\nresult"


class _Stream:
    """A fake `colab exec` process whose stdout lines the test feeds."""

    def __init__(self):
        self.lines: queue.Queue[bytes | None] = queue.Queue()
        self.stdout = self
        self.returncode = None

    def readline(self):
        try:
            line = self.lines.get(timeout=30)
        except queue.Empty:
            line = None
        if line is None:
            self.returncode = 0
            return b""
        return line

    def emit(self, seq, ev, **data):
        self.lines.put((EVENT_PREFIX + json.dumps({"seq": seq, "t": time.time(), "ev": ev, **data}) + "\n").encode())

    def end(self, *, clean=True):
        if clean:
            self.lines.put((ATTACH_END_PREFIX + '{"last_seq": 0}\n').encode())
        self.lines.put(None)

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return self.returncode

    def kill(self):
        self.lines.put(None)


class _FakeCLI:
    def __init__(self, sessions=()):
        self.calls: list[tuple] = []
        self.uploads: dict[str, bytes] = {}
        self.files: dict[str, bytes] = {}  # VM files by path; others download as PNG
        self.streams: queue.Queue[_Stream] = queue.Queue()
        self.attached: list[str] = []
        self.session_list = list(sessions)
        self.alive = True

    def sessions(self):
        return list(self.session_list) if self.alive else []

    def new(self, name, gpu):
        self.calls.append(("new", name, gpu))
        self.session_list = [ColabSession(name, "endpoint", gpu, "Standard", "GPU")]

    def exec_code(self, name, code, *, timeout=120.0, attempts=3):
        self.calls.append(("exec", name, code[:40]))
        return subprocess.CompletedProcess(["colab"], 0, "", "")

    def exec_stream(self, name, code, *, timeout):
        self.attached.append(code)
        stream = _Stream()
        self.streams.put(stream)
        return stream

    def upload(self, name, local, remote):
        self.uploads[remote] = local.read_bytes()

    def download(self, name, remote, local):
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(self.files.get(remote, PNG))
        self.calls.append(("download", remote))

    def stop(self, name):
        self.calls.append(("stop", name))
        self.alive = False
        return True

    def token_present(self):
        return True


def _wait(condition, timeout=15.0, label="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {label}")


def test_drive_mount_waits_for_explicit_confirmation(tmp_path, runtimes):
    cli = _FakeCLI()
    process = subprocess.Popen([sys.executable, "-u", "-c",
        "print('[colab] REQUIRED: Google Drive Authorization needed.'); "
        "print('https://accounts.google.com/test-consent'); input()"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    cli.start_drive_mount = lambda name: process
    runtime = runtimes(ConfigStore(tmp_path / "config.json"), tmp_path / "cache", cli)
    runtime.state = "booting"
    errors = []
    def mount():
        try:
            runtime._mount_drive("test")
        except Exception as exc:
            errors.append(exc)
    thread = threading.Thread(target=mount)
    thread.start()
    try:
        _wait(lambda: runtime.drive_auth_url is not None, timeout=3)
        assert process.poll() is None
        assert runtime.status()["model_cache"]["auth_url"] == "https://accounts.google.com/test-consent"
        runtime.continue_drive_auth()
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert not errors
        assert runtime.drive_cache_state == "ready"
        assert runtime.drive_auth_url is None
        assert runtime._drive_process is None
    finally:
        if process.poll() is None:
            process.kill()
        thread.join(timeout=3)


def test_stopping_drive_mount_terminates_pending_process(tmp_path, runtimes):
    cli = _FakeCLI()
    process = subprocess.Popen([sys.executable, "-u", "-c", "input()"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    cli.start_drive_mount = lambda name: process
    runtime = runtimes(ConfigStore(tmp_path / "config.json"), tmp_path / "cache", cli)
    runtime.state = "off"
    with pytest.raises(colab_runtime.ColabCLIError, match="cancelled"):
        runtime._mount_drive("test")
    assert process.poll() is not None
    assert runtime._drive_process is None


def test_cache_identity_does_not_use_temporary_signed_url(tmp_path, monkeypatch, runtimes):
    runtime = runtimes(ConfigStore(tmp_path / "config.json"), tmp_path / "cache", _FakeCLI())
    item = {"folder": "loras", "filename": "model.safetensors", "url": "https://civitai.com/api/download/models/1"}
    monkeypatch.setattr(colab_runtime, "signed_civitai_url", lambda *args: "https://cdn.example.com/a?signature=one")
    first = runtime._resolved([item])[0]
    monkeypatch.setattr(colab_runtime, "signed_civitai_url", lambda *args: "https://cdn.example.com/a?signature=two")
    second = runtime._resolved([item])[0]
    assert first["cache_key"] == second["cache_key"]
    assert first["url"] != second["url"]


@pytest.fixture
def runtimes():
    made: list[ColabRuntime] = []

    def make(store, cache_dir, cli):
        runtime = ColabRuntime(store, cache_dir=cache_dir, cli=cli)
        made.append(runtime)
        return runtime

    yield make
    for runtime in made:
        runtime.close()
        while not runtime.cli.streams.empty():
            runtime.cli.streams.get().end()


@pytest.fixture
def store(tmp_path):
    item = ConfigStore(tmp_path / "config.json")
    item.update_remote_settings(backend="colab", colab_gpu="G4", colab_idle_minutes=10)
    save_civitai_token(item, "secret-token")
    item.update_comfyui_settings(output_dir=str(tmp_path / "comfy-output"))
    return item


@pytest.fixture
def signed(monkeypatch):
    seen = []

    def fake(url, token, *, opener=None):
        seen.append((url, token))
        return "https://b2.civitai.com/file/model.safetensors?Authorization=short-lived"

    monkeypatch.setattr(colab_runtime, "signed_civitai_url", fake)
    return seen


def _text_workflow():
    return compile_simple_workflow(PROFILE, positive_prompt="A lighthouse", seed=1, mode="text", dimensions=(1024, 1024))


def test_resources_follow_the_files_a_workflow_loads():
    text = {item["filename"] for item in job_resources(_text_workflow())}
    assert "moodyKrea2Mix_v40.safetensors" in text and "krea2_turbo_sda_v1.0_comfy.safetensors" in text
    assert "krea2_identity_edit_v1_2_r64.safetensors" not in text
    edit = compile_edit_workflow(PROFILE, instruction="red sweater", source_image="mediastudio/src.png", dimensions=(1024, 1024))
    assert "krea2_identity_edit_v1_2_r64.safetensors" in {item["filename"] for item in job_resources(edit)}
    assert job_inputs(edit, {"mediastudio/src.png", "mediastudio/other.png"}) == ["mediastudio/src.png"]


def test_a_job_runs_from_upload_to_import(store, tmp_path, signed, runtimes):
    cli = _FakeCLI()
    runtime = runtimes(store, tmp_path / "cache", cli)
    client = ColabComfyUIClient(runtime)
    assert client.upload_image("mediastudio_source_x.png", b"photo") == {"name": "mediastudio_source_x.png", "subfolder": "mediastudio", "type": "input"}
    workflow = _text_workflow()
    workflow["99"] = {"class_type": "LoadImage", "inputs": {"image": "mediastudio/mediastudio_source_x.png"}}
    prompt_id = client.queue_prompt(workflow, client_id="x", extra_data={"extra_pnginfo": {"mediastudio_prompt": "A lighthouse"}})["prompt_id"]
    assert client.get_job(prompt_id)["status"] == "pending"

    stream = cli.streams.get(timeout=15)
    assert [call[0] for call in cli.calls[:3]] == ["new", "exec", "exec"]
    assert cli.calls[0][2] == "G4"
    stream.emit(1, "hello", stage="booting")
    stream.emit(2, "ready", gpu="NVIDIA RTX PRO 6000 Blackwell Server Edition, 97887 MiB")
    _wait(lambda: f"/content/mediastudio/inbox/{prompt_id}.job.json" in cli.uploads, label="job upload")
    assert cli.uploads["/content/mediastudio/inbox/inputs/mediastudio_source_x.png"] == b"photo"
    job = json.loads(cli.uploads[f"/content/mediastudio/inbox/{prompt_id}.job.json"])
    assert job["inputs"] == ["mediastudio/mediastudio_source_x.png"]
    moody = next(item for item in job["resources"] if item["filename"] == "moodyKrea2Mix_v40.safetensors")
    assert moody["url"].startswith("https://b2.civitai.com/")
    assert signed[0][1] == "secret-token"
    assert "secret-token" not in json.dumps(job)
    assert "/content/mediastudio/inbox/settings.json" not in cli.uploads, "boot already carried the idle time"

    runtime.monitor.track(prompt_id, workflow)
    stream.emit(3, "job_received", job=prompt_id)
    stream.emit(4, "download", job=prompt_id, file="moodyKrea2Mix_v40.safetensors", state="progress", done=50, total=100)
    _wait(lambda: runtime.run_details(prompt_id)["downloads"], label="download progress")
    assert runtime.run_details(prompt_id)["downloads"]["moodyKrea2Mix_v40.safetensors"]["done"] == 50
    stream.emit(5, "job_queued", job=prompt_id)
    stream.emit(6, "comfy", job=prompt_id, msg={"type": "execution_start", "data": {"prompt_id": prompt_id}})
    stream.emit(7, "comfy", job=prompt_id, msg={"type": "progress", "data": {"prompt_id": prompt_id, "node": "12", "value": 3, "max": 6}})
    _wait(lambda: client.get_job(prompt_id)["status"] == "in_progress", label="running")
    assert runtime.monitor.snapshot(prompt_id)["step"] == 3
    outputs = {"9": {"images": [{"filename": "krea2_00001_.png", "subfolder": "MediaStudio/Create", "type": "output"}]}}
    stream.emit(8, "job_done", job=prompt_id, outputs=outputs, files=[
        {"filename": "krea2_00001_.png", "subfolder": "MediaStudio/Create", "type": "output", "path": f"/content/mediastudio/outbox/{prompt_id}/krea2_00001_.png"},
    ])
    _wait(lambda: client.get_job(prompt_id)["status"] == "completed", label="completed")
    done = client.get_job(prompt_id)
    image = done["outputs"]["9"]["images"][0]
    assert image == {**outputs["9"]["images"][0], "mediastudio_job": prompt_id} and done["workflow"]["prompt"] == workflow
    assert client.download_output(image) == PNG
    _wait(lambda: f"/content/mediastudio/inbox/{prompt_id}.collected" in cli.uploads, label="collected marker")
    assert runtime.status()["images_done"] == 1


def test_jobs_with_the_same_output_name_get_their_own_images(store, tmp_path, signed, runtimes):
    # The VM empties ComfyUI's output folder after each job, so each job's first image
    # is krea2_00001_.png again.
    cli = _FakeCLI()
    runtime = runtimes(store, tmp_path / "cache", cli)
    client = ColabComfyUIClient(runtime)
    stream = None
    seq = 1
    names = []
    for picture in (b"first picture", b"second picture"):
        prompt_id = client.queue_prompt(_text_workflow(), client_id="x")["prompt_id"]
        if stream is None:
            stream = cli.streams.get(timeout=15)
            stream.emit(1, "ready", gpu="G4")
        _wait(lambda job=prompt_id: f"/content/mediastudio/inbox/{job}.job.json" in cli.uploads, label="job upload")
        item = {"filename": "krea2_00001_.png", "subfolder": "MediaStudio/Create", "type": "output"}
        path = f"/content/mediastudio/outbox/{prompt_id}/krea2_00001_.png"
        cli.files[path] = picture
        seq += 1
        stream.emit(seq, "job_done", job=prompt_id, outputs={"9": {"images": [item]}}, files=[{**item, "path": path}])
        _wait(lambda job=prompt_id: client.get_job(job)["status"] == "completed", label="completed")
        image = client.get_job(prompt_id)["outputs"]["9"]["images"][0]
        assert client.download_output(image) == picture
        names.append(image["filename"])
    with pytest.raises(FileNotFoundError):
        client.download_output(item)
    # Both results also land in ComfyUI's output folder, numbered on from what is there.
    saved = tmp_path / "comfy-output" / "MediaStudio" / "Create"
    assert (saved / "krea2_00001_.png").read_bytes() == b"first picture"
    assert (saved / "krea2_00002_.png").read_bytes() == b"second picture"
    # The library names each image as its file in the output folder is named.
    assert names == ["krea2_00001_.png", "krea2_00002_.png"]


def test_saving_to_output_takes_the_next_free_name(tmp_path):
    source = tmp_path / "result.png"
    source.write_bytes(b"image")
    output = tmp_path / "output"
    (output / "MediaStudio" / "Create").mkdir(parents=True)
    (output / "MediaStudio" / "Create" / "krea2_00007_.png").write_bytes(b"older")
    (output / "MediaStudio" / "Create" / "krea2_edit_00009_.png").write_bytes(b"other prefix")
    assert save_to_output(output, "MediaStudio/Create", "krea2_00001_.png", source).name == "krea2_00008_.png"
    assert save_to_output(output, "MediaStudio/Create", "krea2_edit_00001_.png", source).name == "krea2_edit_00010_.png"
    assert save_to_output(output, "", "plain.png", source) == output / "plain_00001_.png"
    with pytest.raises(ValueError):
        save_to_output(output, "../outside", "krea2_00001_.png", source)


def test_cancel_before_sending_and_after(store, tmp_path, signed, runtimes):
    cli = _FakeCLI()
    runtime = runtimes(store, tmp_path / "cache", cli)
    client = ColabComfyUIClient(runtime)
    waiting = client.queue_prompt(_text_workflow(), client_id="x")["prompt_id"]
    client.cancel_prompt(waiting)
    assert client.get_job(waiting)["status"] == "cancelled"

    stream = cli.streams.get(timeout=15)
    stream.emit(1, "ready", gpu="G4")
    sent = client.queue_prompt(_text_workflow(), client_id="x")["prompt_id"]
    _wait(lambda: f"/content/mediastudio/inbox/{sent}.job.json" in cli.uploads, label="job upload")
    client.cancel_prompt(sent)
    _wait(lambda: f"/content/mediastudio/inbox/{sent}.cancel" in cli.uploads, label="cancel marker")
    stream.emit(2, "job_cancelled", job=sent)
    _wait(lambda: client.get_job(sent)["status"] == "cancelled", label="cancelled")


def test_refused_gpu_fails_the_waiting_runs(store, tmp_path, runtimes):
    cli = _FakeCLI()

    def refuse(name, gpu):
        raise ColabCLIError("Your Colab plan has no H100 available right now.", code="gpu_rejected")

    cli.new = refuse
    runtime = runtimes(store, tmp_path / "cache", cli)
    client = ColabComfyUIClient(runtime)
    prompt_id = client.queue_prompt(_text_workflow(), client_id="x")["prompt_id"]
    _wait(lambda: client.get_job(prompt_id)["status"] == "failed", label="failed")
    assert client.get_job(prompt_id)["execution_error"]["code"] == "gpu_rejected"
    assert runtime.status()["state"] == "error"


def test_a_runtime_started_despite_a_timeout_is_stopped(store, tmp_path, runtimes):
    cli = _FakeCLI()
    reachable = {"now": False}

    def time_out(name, gpu):
        # Colab created the runtime, but the answer never reached the CLI.
        cli.calls.append(("new", name, gpu))
        cli.session_list = [ColabSession(name, "endpoint", gpu, "Standard", "GPU")]
        raise ColabCLIError("Colab did not answer in time.", code="colab_unreachable")

    def sessions():
        if not reachable["now"]:
            raise ColabCLIError("Colab sessions are unavailable.", code="sessions_failed")
        return list(cli.session_list) if cli.alive else []

    cli.new, cli.sessions = time_out, sessions
    runtime = runtimes(store, tmp_path / "cache", cli)
    client = ColabComfyUIClient(runtime)
    prompt_id = client.queue_prompt(_text_workflow(), client_id="x")["prompt_id"]
    _wait(lambda: client.get_job(prompt_id)["status"] == "failed", label="failed")
    name = cli.calls[0][1]
    record = tmp_path / "cache" / "runtimes" / f"{name}.json"
    assert json.loads(record.read_text(encoding="utf-8"))["unconfirmed"] is True
    # While Colab is unreachable the record stays; once it answers, the runtime is stopped.
    reachable["now"] = True
    runtime._unconfirmed_checked_at = float("-inf")
    runtime._wake.set()
    _wait(lambda: ("stop", name) in cli.calls, label="orphan stopped")
    runtime._unconfirmed_checked_at = float("-inf")
    runtime._wake.set()
    _wait(lambda: not record.exists(), label="record forgotten")


def test_a_refused_runtime_leaves_no_record(store, tmp_path, runtimes):
    cli = _FakeCLI()

    def refuse(name, gpu):
        raise ColabCLIError("Colab refused the runtime.", code="allocation_refused")

    cli.new = refuse
    runtime = runtimes(store, tmp_path / "cache", cli)
    runtime.ensure_started()
    _wait(lambda: runtime.status()["state"] == "error", label="error")
    assert not list((tmp_path / "cache" / "runtimes").glob("*.json"))


def test_idle_runtime_is_stopped(store, tmp_path, signed, runtimes):
    cli = _FakeCLI()
    runtime = runtimes(store, tmp_path / "cache", cli)
    runtime.ensure_started()
    stream = cli.streams.get(timeout=15)
    stream.emit(1, "ready", gpu="G4")
    _wait(lambda: runtime.status()["state"] == "ready", label="ready")
    assert runtime.status()["stops_in_seconds"] > 500
    runtime.last_activity = time.time() - 11 * 60
    runtime._wake.set()
    _wait(lambda: runtime.status()["state"] == "off", label="idle stop")
    assert ("stop", runtime.cli.calls[0][1]) in cli.calls


def _record(tmp_path, name, pid):
    folder = tmp_path / "cache" / "runtimes"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps({"name": name, "pid": pid}), encoding="utf-8")


def _ended_pid():
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


def test_only_recorded_runtimes_of_an_ended_mediastudio_are_adopted(store, tmp_path, runtimes):
    sessions = [ColabSession(name, "endpoint", "G4", "Standard", "GPU") for name in ("mediastudio-byhand", "mediastudio-live")]
    _record(tmp_path, "mediastudio-live", os.getppid())  # its MediaStudio process still runs
    cli = _FakeCLI(sessions=sessions)
    runtime = runtimes(store, tmp_path / "cache", cli)
    time.sleep(0.5)
    assert runtime.status()["state"] == "off" and runtime.status()["name"] is None
    assert cli.attached == []


def test_a_runtime_from_before_a_restart_is_adopted(store, tmp_path, runtimes):
    _record(tmp_path, "mediastudio-1234abcd", _ended_pid())
    cli = _FakeCLI(sessions=[ColabSession("mediastudio-1234abcd", "endpoint", "G4", "Standard", "GPU")])
    runtime = runtimes(store, tmp_path / "cache", cli)
    stream = cli.streams.get(timeout=15)
    assert runtime.status()["name"] == "mediastudio-1234abcd"
    assert cli.attached[0].startswith("MEDIASTUDIO_WORKER.attach(0,")
    assert not any(call[0] == "new" for call in cli.calls)
    # A job of the previous MediaStudio still finishes: its run imports the output.
    stream.emit(1, "ready", gpu="G4")
    old = "0f8b9e2c-4d3a-4c1e-9b7a-2e6d5c4b3a21"
    stream.emit(2, "job_done", job=old, outputs={}, files=[{"filename": "a.png", "subfolder": "", "path": "/content/mediastudio/outbox/a.png"}])
    _wait(lambda: (runtime.job_snapshot(old) or {}).get("status") == "completed", label="old job")
    record = json.loads((tmp_path / "cache" / "runtimes" / "mediastudio-1234abcd.json").read_text(encoding="utf-8"))
    assert record["pid"] == os.getpid(), "the adopting process owns the runtime now"


def test_pid_alive():
    assert colab_runtime.pid_alive(os.getpid())
    assert not colab_runtime.pid_alive(_ended_pid())
    assert not colab_runtime.pid_alive(None)


def test_a_lost_runtime_fails_its_runs(store, tmp_path, signed, runtimes):
    cli = _FakeCLI()
    runtime = runtimes(store, tmp_path / "cache", cli)
    client = ColabComfyUIClient(runtime)
    prompt_id = client.queue_prompt(_text_workflow(), client_id="x")["prompt_id"]
    stream = cli.streams.get(timeout=15)
    stream.emit(1, "ready", gpu="G4")
    _wait(lambda: f"/content/mediastudio/inbox/{prompt_id}.job.json" in cli.uploads, label="job upload")
    cli.alive = False
    stream.end(clean=False)
    _wait(lambda: client.get_job(prompt_id)["status"] == "failed", label="failed")
    assert client.get_job(prompt_id)["execution_error"]["code"] == "runtime_stopped"
    assert runtime.status()["state"] == "off"


def test_backend_health_and_readiness(store, tmp_path, runtimes):
    cli = _FakeCLI()
    runtime = runtimes(store, tmp_path / "cache", cli)
    backend = ColabBackend(runtime)
    health = backend.profile_health(PROFILE)
    assert health["status"] == "ready" and health["modes_ready"]["edit"] is True
    assert health["backend"]["kind"] == "colab" and health["backend"]["signed_in"] is True
    assert health["backend"]["civitai_ready"] is True
    clear_civitai_token(store)
    assert backend.profile_health(PROFILE)["backend"]["civitai_ready"] is False
    assert backend.ensure_ready(1) is False
    assert backend.not_ready_payload()["code"] == "civitai_token_required"
    # Once the model is on the runtime the token is no longer needed.
    runtime.vm_files.update({"moodyKrea2Mix_v40.safetensors", "krea2_identity_edit_v1_2_r64.safetensors"})
    assert backend.civitai_ready(PROFILE) is True
    save_civitai_token(store, "secret-token")
    cli.token_present = lambda: False
    backend._signed_in = None
    runtime.state = "off"
    assert backend.ensure_ready(1) is False
    assert backend.not_ready_payload()["code"] == "colab_signed_out"


class _Opener:
    def __init__(self, code, location=None):
        self.code, self.location, self.requests = code, location, []

    def open(self, request, timeout=30):
        self.requests.append(request)
        headers = {"Location": self.location} if self.location else {}
        raise urllib.error.HTTPError(request.full_url, self.code, "x", headers, io.BytesIO(b""))


def test_signed_civitai_url_keeps_the_token_local():
    opener = _Opener(307, "https://b2.civitai.com/file/x.safetensors?Authorization=3_abc")
    url = "https://civitai.com/api/download/models/3117958?fileId=2998244"
    assert signed_civitai_url(url, "tok", opener=opener).startswith("https://b2.civitai.com/")
    assert opener.requests[0].get_header("Authorization") == "Bearer tok"
    with pytest.raises(ColabCLIError) as excinfo:
        signed_civitai_url(url, "", opener=_Opener(401))
    assert excinfo.value.code == "civitai_token_required"
    with pytest.raises(ColabCLIError):
        signed_civitai_url(url, "tok", opener=_Opener(307, "https://b2.civitai.com/x?token=tok"))


def test_drive_timeout_is_not_reported_as_user_cancellation(tmp_path, monkeypatch, runtimes):
    cli = _FakeCLI()
    process = subprocess.Popen([sys.executable, "-u", "-c", "input()"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    cli.start_drive_mount = lambda name: process
    runtime = runtimes(ConfigStore(tmp_path / "config.json"), tmp_path / "cache", cli)
    runtime.state = "booting"
    monkeypatch.setattr(colab_runtime, "DRIVE_AUTH_TIMEOUT_SECONDS", 0)
    with pytest.raises(ColabCLIError) as caught:
        runtime._mount_drive("test")
    assert caught.value.code == "drive_auth_timeout"
    assert "cancelled" not in str(caught.value)
    assert process.poll() is not None
