from __future__ import annotations

import hashlib
import http.server
import io
import json
import os
import threading
import time
import zipfile

import pytest

from app.remote import colab_worker as cw

WORKFLOW = {"9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "MediaStudio/Create/krea2"}}}
JOB = "0f8b9e2c-4d3a-4c1e-9b7a-2e6d5c4b3a21"
EARLY = "11111111-2222-4333-8444-555555555555"
LATE = "66666666-7777-4888-9999-aaaaaaaaaaaa"


def _cached_worker(tmp_path, monkeypatch):
    worker = cw.Worker(root=tmp_path / "worker", comfy_dir=tmp_path / "ComfyUI")
    worker.model_cache_dir = tmp_path / "drive"
    content = b"complete model weights"
    resource = {"folder": "loras", "filename": "model.safetensors",
                "url": "https://example.com/model", "sha256": hashlib.sha256(content).hexdigest()}
    calls = []
    def download(resource, target, job_id):
        calls.append(resource["url"])
        target.write_bytes(content)
    monkeypatch.setattr(worker, "_http_download", download)
    target = worker.comfy_dir / "models/loras/model.safetensors"
    return worker, resource, target, content, calls


def test_download_is_cached_and_restored_without_network(tmp_path, monkeypatch):
    worker, resource, target, content, calls = _cached_worker(tmp_path, monkeypatch)
    worker._ensure_resource(resource, JOB)
    target.unlink()
    worker._cached_models.clear()
    worker._ensure_resource(resource, JOB)
    assert calls == [resource["url"]]
    assert target.read_bytes() == content
    assert any(event["ev"] == "model_cache" and event["state"] == "restored" for event in worker.log.after(0))


@pytest.mark.parametrize("corruption", ["weights", "manifest", "missing_manifest"])
def test_corrupt_cache_is_downloaded_and_repaired(tmp_path, monkeypatch, corruption):
    worker, resource, target, content, calls = _cached_worker(tmp_path, monkeypatch)
    worker._ensure_resource(resource, JOB)
    cached, manifest = worker._cache_paths(resource)
    if corruption == "weights":
        cached.write_bytes(b"x" * len(content))
    elif corruption == "manifest":
        manifest.write_text("{broken")
    else:
        manifest.unlink()
    target.unlink()
    worker._cached_models.clear()
    worker._ensure_resource(resource, JOB)
    assert len(calls) == 2
    assert cached.read_bytes() == target.read_bytes() == content
    assert json.loads(manifest.read_text())["sha256"] == resource["sha256"]


def test_cache_write_failure_preserves_downloaded_model(tmp_path, monkeypatch):
    worker, resource, target, content, calls = _cached_worker(tmp_path, monkeypatch)
    worker.model_cache_dir.write_text("not a directory")
    worker._ensure_resource(resource, JOB)
    assert target.read_bytes() == content
    assert len(calls) == 1
    assert any(event["ev"] == "model_cache" and event["state"] == "warning" for event in worker.log.after(0))


def test_cache_cancel_does_not_publish_partial_file(tmp_path, monkeypatch):
    worker, _, target, content, _ = _cached_worker(tmp_path, monkeypatch)
    source = tmp_path / "source"
    source.write_bytes(content)
    worker._stop.set()
    with pytest.raises(cw.WorkerError, match="cancelled"):
        worker._copy_model(source, target, None)
    assert not target.exists()
    assert not list(target.parent.glob("*.part"))


def test_model_cache_key_cannot_escape_cache_directory():
    with pytest.raises(cw.WorkerError, match="cache key"):
        cw.parse_job(_job(resources=[{"folder": "loras", "filename": "model", "url": "https://example.com/m",
                                     "cache_key": "../outside"}]))


def _job(**overrides):
    job = {
        "id": JOB,
        "client_id": "mediastudio-create-x",
        "workflow": WORKFLOW,
        "extra_data": {"extra_pnginfo": {"mediastudio_prompt": "a lighthouse"}},
        "inputs": ["mediastudio/mediastudio_source_abc.png"],
        "resources": [{
            "folder": "diffusion_models", "filename": "model.safetensors",
            "url": "https://example.com/model.safetensors", "sha256": "A" * 64,
        }],
    }
    job.update(overrides)
    return json.dumps(job)


def test_parse_job_keeps_only_safe_names():
    job = cw.parse_job(_job())
    assert job["inputs"] == ["mediastudio_source_abc.png"]
    assert job["resources"][0]["sha256"] == "a" * 64
    for bad in (
        {"id": "../escape"},
        {"id": "live-text"},
        {"id": JOB.upper()},
        {"workflow": {}},
        {"inputs": [".."]},
        {"resources": [{"folder": "../x", "filename": "m", "url": "https://e.com/m"}]},
        {"resources": [{"folder": "loras", "filename": "m", "url": "http://e.com/m"}]},
        {"resources": [{"folder": "loras", "filename": "m", "url": "https://e.com/m", "sha256": "xyz"}]},
    ):
        with pytest.raises(cw.WorkerError):
            cw.parse_job(_job(**bad))
    with pytest.raises(cw.WorkerError):
        cw.parse_job("{not json")


def test_hf_parts_and_watchdog():
    url = "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors?download=true"
    assert cw.hf_parts(url) == ("Comfy-Org/Krea-2", "main", "text_encoders/qwen3vl_4b_fp8_scaled.safetensors")
    assert cw.hf_parts("https://civitai.com/api/download/models/1") is None
    due = {"now": 1000.0, "idle_seconds": 600, "grace": 120}
    assert cw.watchdog_due(last_activity=270.0, busy=False, **due)
    assert not cw.watchdog_due(last_activity=290.0, busy=False, **due)
    assert not cw.watchdog_due(last_activity=0.0, busy=True, **due)


def test_output_files_and_archive_members():
    outputs = {"9": {"images": [{"filename": "krea2_00001_.png", "subfolder": "MediaStudio/Create", "type": "output"}]}}
    assert cw.output_files(outputs) == [{
        "filename": "krea2_00001_.png", "subfolder": "MediaStudio/Create", "type": "output", "node_id": "9", "media_key": "images",
    }]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("repo-abc/__init__.py", b"ok")
        archive.writestr("repo-abc/../../evil.py", b"x")
    with zipfile.ZipFile(buffer) as archive, pytest.raises(cw.WorkerError):
        cw.archive_members(archive)


def test_event_log_and_attach_resume_after_a_sequence(tmp_path, capsys):
    worker = cw.Worker(root=tmp_path / "mediastudio", comfy_dir=tmp_path / "ComfyUI")
    for index in range(3):
        worker.log.emit("boot", stage=f"s{index}")
    worker.attach(after_seq=1, seconds=0.05)
    lines = capsys.readouterr().out.splitlines()
    events = [json.loads(line[len(cw.EVENT_PREFIX):]) for line in lines if line.startswith(cw.EVENT_PREFIX)]
    assert [event["seq"] for event in events] == [2, 3]
    assert lines[-1] == cw.ATTACH_END_PREFIX + json.dumps({"last_seq": 3})
    stored = (tmp_path / "mediastudio" / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["stage"] for line in stored] == ["s0", "s1", "s2"]


class _Inline:
    def submit(self, fn, *args):
        fn(*args)


class _FakeComfy:
    """Records worker calls to ComfyUI's HTTP API."""

    def __init__(self, history=None, queue=None):
        self.calls: list[tuple[str, str, object]] = []
        self.history = history or {}
        self.queue = queue or {"queue_running": [], "queue_pending": []}

    def __call__(self, method, path, payload=None, *, timeout=30.0):
        self.calls.append((method, path, payload))
        if path == "/prompt":
            return {"prompt_id": payload["prompt_id"], "number": 1}
        if path.startswith("/history/"):
            return self.history
        if path == "/queue" and method == "GET":
            return self.queue
        return {}


@pytest.fixture
def worker(tmp_path):
    item = cw.Worker(root=tmp_path / "mediastudio", comfy_dir=tmp_path / "ComfyUI")
    item._prep = _Inline()
    item.ready.set()
    model = tmp_path / "ComfyUI" / "models" / "diffusion_models" / "model.safetensors"
    model.parent.mkdir(parents=True)
    model.write_bytes(b"weights")
    (item.inputs / "mediastudio_source_abc.png").write_bytes(b"png")
    return item


def _age(path, *, write=False, seconds=5):
    if write:
        path.write_text("", encoding="utf-8")
    old = time.time() - seconds
    os.utime(path, (old, old))


def _events(worker, ev):
    return [event for event in worker.log.after(0) if event["ev"] == ev]


def test_inbox_job_is_prepared_and_queued(worker):
    comfy = worker._api = _FakeComfy()
    (worker.inbox / f"{JOB}.job.json").write_text(_job(), encoding="utf-8")
    worker._scan_inbox()
    assert worker.jobs[JOB]["state"] == "queued"
    assert (worker.comfy_dir / "input" / "mediastudio" / "mediastudio_source_abc.png").read_bytes() == b"png"
    method, path, payload = comfy.calls[-1]
    assert (method, path) == ("POST", "/prompt")
    assert payload["prompt_id"] == JOB and payload["client_id"] == worker.client_id
    assert payload["extra_data"]["extra_pnginfo"]["mediastudio_prompt"] == "a lighthouse"
    assert [event["ev"] for event in worker.log.after(0)] == ["job_received", "job_queued"]


def test_missing_input_fails_the_job(worker):
    worker._api = _FakeComfy()
    (worker.inputs / "mediastudio_source_abc.png").unlink()
    (worker.inbox / f"{JOB}.job.json").write_text(_job(), encoding="utf-8")
    worker._scan_inbox()
    assert worker.jobs[JOB]["state"] == "failed"
    assert "was not uploaded" in _events(worker, "job_failed")[0]["message"]


def test_rejected_workflow_reports_comfyui_errors(worker):
    def reject(method, path, payload=None, *, timeout=30.0):
        raise cw.ComfyRejected(400, {"error": {"message": "Prompt outputs failed validation"}, "node_errors": {}})

    worker._api = reject
    (worker.inbox / f"{JOB}.job.json").write_text(_job(), encoding="utf-8")
    worker._scan_inbox()
    failed = _events(worker, "job_failed")[0]
    assert failed["error"]["error"]["message"] == "Prompt outputs failed validation"


def test_cancel_before_queueing_and_while_running(worker):
    worker._api = _FakeComfy()
    worker.jobs[EARLY] = {"state": "preparing", "job": cw.parse_job(_job(id=EARLY))}
    worker._cancel(EARLY)
    assert worker.jobs[EARLY]["state"] == "cancelled"
    assert _events(worker, "job_cancelled")[0]["job"] == EARLY

    comfy = worker._api = _FakeComfy(queue={"queue_running": [[1, LATE]], "queue_pending": []})
    worker.jobs[LATE] = {"state": "running", "job": cw.parse_job(_job(id=LATE))}
    worker._cancel(LATE)
    assert ("POST", "/interrupt", {"prompt_id": LATE}) in comfy.calls


def test_finish_copies_outputs_and_collect_removes_everything(worker):
    output = worker.comfy_dir / "output" / "MediaStudio" / "Create" / "krea2_00001_.png"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"result")
    outputs = {"9": {"images": [{"filename": "krea2_00001_.png", "subfolder": "MediaStudio/Create", "type": "output"}]}}
    history = {JOB: {"status": {"status_str": "success", "messages": []}, "outputs": outputs}}
    comfy = worker._api = _FakeComfy(history=history)
    (worker.inbox / f"{JOB}.job.json").write_text(_job(), encoding="utf-8")
    worker._scan_inbox()
    worker._finish(JOB)
    done = _events(worker, "job_done")[0]
    assert done["files"][0]["bytes"] == 6
    assert (worker.outbox / JOB / "krea2_00001_.png").read_bytes() == b"result"

    _age(worker.inbox / f"{JOB}.collected", write=True)
    worker._scan_inbox()
    assert not (worker.outbox / JOB).exists()
    assert not output.exists()
    assert not (worker.inputs / "mediastudio_source_abc.png").exists()
    assert JOB not in worker.jobs
    assert ("POST", "/history", {"delete": [JOB]}) in comfy.calls


def test_a_shared_photo_stays_until_the_last_job_of_the_batch_is_collected(worker):
    worker._api = _FakeComfy(history={})
    second = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    for job_id in (JOB, second):
        (worker.inbox / f"{job_id}.job.json").write_text(_job(id=job_id), encoding="utf-8")
    worker._scan_inbox()
    shared = worker.inputs / "mediastudio_source_abc.png"
    copied = worker.comfy_dir / "input" / "mediastudio" / "mediastudio_source_abc.png"
    _age(worker.inbox / f"{JOB}.collected", write=True)
    worker._scan_inbox()
    assert shared.exists() and copied.exists(), "the batch's other job still needs the photo"
    _age(worker.inbox / f"{second}.collected", write=True)
    worker._scan_inbox()
    assert not shared.exists() and not copied.exists()


def test_failed_history_reports_the_execution_error(worker):
    error = {"node_id": "7", "exception_message": "CUDA out of memory"}
    history = {JOB: {"status": {"status_str": "error", "messages": [["execution_error", error]]}, "outputs": {}}}
    worker._api = _FakeComfy(history=history)
    worker.jobs[JOB] = {"state": "running", "job": cw.parse_job(_job())}
    worker._finish(JOB)
    assert _events(worker, "job_failed")[0]["error"] == error


@pytest.fixture
def file_server():
    body = b"x" * (3 * 1024 * 1024 + 7)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/file", body
    server.shutdown()


def test_http_download_checks_sha256(worker, file_server):
    url, body = file_server
    target = worker.comfy_dir / "models" / "loras" / "lora.safetensors"
    target.parent.mkdir(parents=True)
    good = {"folder": "loras", "filename": "lora.safetensors", "url": url, "sha256": hashlib.sha256(body).hexdigest()}
    worker._http_download(good, target, JOB)
    assert target.read_bytes() == body

    bad_target = target.with_name("other.safetensors")
    with pytest.raises(cw.WorkerError):
        worker._http_download({**good, "filename": "other.safetensors", "sha256": "0" * 64}, bad_target, JOB)
    assert not bad_target.exists()
    assert not bad_target.with_name("other.safetensors.part").exists()


def test_detach_ends_attach_and_a_stale_marker_is_ignored(tmp_path, capsys):
    worker = cw.Worker(root=tmp_path / "mediastudio", comfy_dir=tmp_path / "ComfyUI")
    worker.log.emit("boot", stage="comfyui")
    (worker.inbox / "detach").write_text("", encoding="utf-8")  # left from an earlier stream
    timer = threading.Timer(0.3, lambda: (worker.inbox / "detach").write_text("", encoding="utf-8"))
    timer.start()
    started = time.monotonic()
    worker.attach(after_seq=0, seconds=30)
    assert time.monotonic() - started < 5
    out = capsys.readouterr().out
    assert '"stage": "comfyui"' in out and cw.ATTACH_END_PREFIX in out
    assert not (worker.inbox / "detach").exists()


def test_settings_file_changes_the_idle_time(worker):
    settings = worker.inbox / "settings.json"
    settings.write_text(json.dumps({"idle_seconds": 300}), encoding="utf-8")
    worker._scan_inbox()
    assert worker.idle_seconds == 600, "a marker is left alone while Jupyter may still read it back"
    _age(settings)
    worker._scan_inbox()
    assert worker.idle_seconds == 300
    assert _events(worker, "settings")[0]["idle_seconds"] == 300
    assert not (worker.inbox / "settings.json").exists()


def test_job_waiting_for_comfyui_fails_when_boot_failed(worker):
    worker._api = _FakeComfy()
    worker.ready.clear()
    worker.stage = "failed"
    (worker.inbox / f"{JOB}.job.json").write_text(_job(), encoding="utf-8")
    worker._scan_inbox()
    assert worker.jobs[JOB]["state"] == "failed"
    assert "could not start" in _events(worker, "job_failed")[0]["message"]
