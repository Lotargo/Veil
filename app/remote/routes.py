"""Remote GPU API: Colab CLI setup, sign-in, usage and settings (docs/COLAB-REMOTE-PLAN.md)."""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from flask import Blueprint, current_app, jsonify, request

from app import startup_checks
from app.config_store import IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, ConfigStore

from . import wsl
from .colab_cli import GPU_CHOICES, ColabCLI, ColabCLIError, LoginFlow

remote_blueprint = Blueprint("remote", __name__)
logger = logging.getLogger(__name__)

USAGE_CACHE_SECONDS = 60.0
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _config_store() -> ConfigStore:
    return current_app.config["CONFIG_STORE"]


def _cli() -> ColabCLI:
    return ColabCLI()


def _local_only():
    """Commands that start programs on this computer answer only to the computer itself."""
    if str(request.remote_addr or "") not in _LOOPBACK:
        return jsonify({"error": "Available only in the app on this computer.", "code": "local_only"}), 403
    return None


def _error(exc: ColabCLIError | wsl.WslError, status: int = 502):
    code = getattr(exc, "code", "wsl_unavailable")
    return jsonify({"error": str(exc), "code": code}), status


class _InstallJob:
    """One install or update of the Colab CLI at a time, with its output for the UI."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.state = "idle"
        self.lines: deque[str] = deque(maxlen=200)
        self.started_at: float | None = None
        self.finished_at: float | None = None

    def start(self, cli: ColabCLI) -> None:
        with self._lock:
            if self.state == "running":
                return
            process = cli.start_install()
            self.state, self.started_at, self.finished_at = "running", time.time(), None
            self.lines.clear()
        threading.Thread(target=self._follow, args=(process,), daemon=True, name="mediastudio-colab-install").start()

    def _follow(self, process: subprocess.Popen[bytes]) -> None:
        def read(stream: Any) -> None:
            for raw in iter(stream.readline, b""):
                text = wsl.decode_output(raw).rstrip()
                if text:
                    with self._lock:
                        self.lines.append(text)

        readers = [threading.Thread(target=read, args=(s,), daemon=True) for s in (process.stdout, process.stderr) if s]
        for reader in readers:
            reader.start()
        code = process.wait()
        for reader in readers:
            reader.join(timeout=5)
        with self._lock:
            self.state = "succeeded" if code == 0 else "failed"
            self.finished_at = time.time()
        _forget_status()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": self.state,
                "log": list(self.lines),
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }


_install = _InstallJob()
_login_lock = threading.Lock()
_login: LoginFlow | None = None
_usage_cache: dict[str, Any] = {"at": 0.0, "payload": None}
# WSL, the CLI version and the account: probed at startup, again on Re-check or after a change.
_status_lock = threading.Lock()
_status_cache: dict[str, Any] | None = None


def _gpu_choices() -> list[dict[str, Any]]:
    return [
        {"id": item.id, "label": item.label, "vram_gb": item.vram_gb, "cu_per_hour": item.cu_per_hour, "note": item.note}
        for item in GPU_CHOICES.values()
    ]


def _settings_payload(store: ConfigStore) -> dict[str, Any]:
    return {
        **store.remote_settings(),
        "idle_minutes_range": [IDLE_MINUTES_MIN, IDLE_MINUTES_MAX],
        "gpus": _gpu_choices(),
    }


def _probe_status() -> dict[str, Any]:
    """WSL, the Colab CLI and the signed-in account, from the cheapest check to the dearest."""
    wsl_state = wsl.status()
    probe: dict[str, Any] = {
        "wsl": wsl_state.to_dict(),
        "cli": {"installed": False, "version": None},
        "account": {"signed_in": False, "email": None, "expires_in": None},
    }
    if not wsl_state.available:
        return probe
    cli = _cli()
    # Each CLI start costs seconds; the version and the account are asked side by side.
    with ThreadPoolExecutor(max_workers=2) as pool:
        version_call, account_call = pool.submit(cli.version), pool.submit(cli.whoami)
        try:
            version = version_call.result()
            account = account_call.result() if version is not None else None
        except (ColabCLIError, wsl.WslError) as exc:
            return {**probe, "error": str(exc)}
    probe["cli"] = {"installed": version is not None, "version": version}
    if account:
        probe["account"] = {"signed_in": True, **account}
    return probe


def _status(*, refresh: bool) -> dict[str, Any]:
    global _status_cache
    if not refresh:
        startup_checks.wait("colab")
        with _status_lock:
            if _status_cache is not None:
                return _status_cache
    probe = _probe_status()
    with _status_lock:
        _status_cache = probe
    return probe


def _forget_status() -> None:
    global _status_cache
    with _status_lock:
        _status_cache = None
    _usage_cache["at"] = 0.0


def _read_usage() -> dict[str, Any]:
    cli = _cli()
    usage = cli.usage()
    sessions = cli.sessions()
    payload = {
        **usage.to_dict(),
        "sessions": [item.to_dict() for item in sessions],
        "checked_at": time.time(),
    }
    _usage_cache.update(at=time.monotonic(), payload=payload)
    return payload


def warm_colab() -> None:
    """Startup check (background): WSL, the CLI and the signed-in account."""
    _status(refresh=True)


def warm_colab_usage() -> None:
    """Startup check (background): the compute-unit balance, once the account is known."""
    if not _status(refresh=False)["account"]["signed_in"]:
        return
    try:
        _read_usage()
    except (ColabCLIError, wsl.WslError) as exc:
        logger.info("Colab usage at startup is unavailable: %s", exc)


@remote_blueprint.route("/api/remote/colab/status", methods=["GET"])
def colab_status():
    """WSL, the Colab CLI and the signed-in account (cached; ``refresh=1`` asks again)."""
    return jsonify({
        **_status(refresh=request.args.get("refresh") == "1"),
        "install": _install.snapshot(),
        "login": {"pending": _login is not None and _login.process.poll() is None},
        "settings": _settings_payload(_config_store()),
    })


@remote_blueprint.route("/api/remote/wsl/install", methods=["POST"])
def wsl_install():
    if (denied := _local_only()) is not None:
        return denied
    try:
        wsl.install_wsl()
    except (OSError, wsl.WslError) as exc:
        return jsonify({"error": str(exc), "code": "wsl_install_failed"}), 502
    return jsonify({"ok": True, "restart_required": True})


@remote_blueprint.route("/api/remote/colab/install", methods=["GET", "POST"])
def colab_install():
    if request.method == "POST":
        if (denied := _local_only()) is not None:
            return denied
        try:
            _install.start(_cli())
        except ColabCLIError as exc:
            return _error(exc)
    return jsonify(_install.snapshot())


@remote_blueprint.route("/api/remote/colab/update", methods=["GET"])
def colab_update_check():
    try:
        cli = _cli()
        return jsonify({"version": cli.version(), "newer_version": cli.newer_version()})
    except (ColabCLIError, wsl.WslError) as exc:
        return _error(exc)


@remote_blueprint.route("/api/remote/colab/login", methods=["POST"])
def colab_login_start():
    """Start the CLI's sign-in and return the Google link; the code comes back separately."""
    global _login
    if (denied := _local_only()) is not None:
        return denied
    with _login_lock:
        if _login is not None:
            _login.cancel()
            _login = None
        cli = _cli()
        try:
            flow = cli.start_login()
            url = flow.wait_for_url()
        except ColabCLIError as exc:
            return _error(exc)
        if url is None:
            account = cli.whoami()
            if account:
                _forget_status()
                return jsonify({"signed_in": True, **account})
            return jsonify({"error": f"The Colab CLI ended without a sign-in link: {flow.output[-300:]}",
                            "code": "login_failed"}), 502
        _login = flow
    return jsonify({"signed_in": False, "url": url})


@remote_blueprint.route("/api/remote/colab/login/code", methods=["POST"])
def colab_login_code():
    global _login
    if (denied := _local_only()) is not None:
        return denied
    code = str((request.get_json(silent=True) or {}).get("code") or "").strip()
    if not code:
        return jsonify({"error": "Paste the code Google showed after sign-in.", "code": "code_required"}), 400
    with _login_lock:
        flow, _login = _login, None
        if flow is None:
            return jsonify({"error": "Start the sign-in first.", "code": "login_not_started"}), 409
        try:
            ok = flow.submit(code)
        except ColabCLIError as exc:
            return _error(exc, 409)
    account = _cli().whoami() if ok else None
    if not account:
        return jsonify({"error": "Google did not accept the code. Start the sign-in again.", "code": "login_failed"}), 400
    _forget_status()
    return jsonify({"signed_in": True, **account})


@remote_blueprint.route("/api/remote/colab/logout", methods=["POST"])
def colab_logout():
    if (denied := _local_only()) is not None:
        return denied
    try:
        _cli().logout()
    except (ColabCLIError, wsl.WslError) as exc:
        return _error(exc)
    _forget_status()
    return jsonify({"signed_in": False})


@remote_blueprint.route("/api/remote/colab/usage", methods=["GET"])
def colab_usage():
    """Compute-unit balance and rate plus the runtimes MediaStudio started (cached for a minute)."""
    refresh = request.args.get("refresh") == "1"
    if not refresh:
        startup_checks.wait("colab-usage")
    cached = _usage_cache["payload"]
    if cached is not None and not refresh and time.monotonic() - _usage_cache["at"] < USAGE_CACHE_SECONDS:
        return jsonify(cached)
    try:
        return jsonify(_read_usage())
    except (ColabCLIError, wsl.WslError) as exc:
        return _error(exc)


def _runtime_payload(store: ConfigStore) -> dict[str, Any]:
    from .colab_backend import existing_runtime

    runtime = existing_runtime()
    if runtime is None:
        colab = store.remote_settings()["colab"]
        return {"state": "off", "gpu": colab["gpu"], "idle_minutes": colab["idle_minutes"], "active_jobs": 0}
    return runtime.status()


@remote_blueprint.route("/api/remote/colab/runtime", methods=["GET"])
def colab_runtime_status():
    """MediaStudio's Colab runtime: off, allocating, booting, ready, stopping or error, with its GPU."""
    return jsonify(_runtime_payload(_config_store()))


@remote_blueprint.route("/api/remote/colab/runtime/start", methods=["POST"])
def colab_runtime_start():
    from .colab_backend import colab_runtime

    if (denied := _local_only()) is not None:
        return denied
    store = _config_store()
    try:
        signed_in = _cli().token_present()
    except (ColabCLIError, wsl.WslError) as exc:
        return _error(exc)
    if not signed_in:
        return jsonify({"error": "Sign in to Google in Integrations › Remote GPU first.", "code": "colab_signed_out"}), 409
    colab_runtime(store).ensure_started()
    return jsonify(_runtime_payload(store))


@remote_blueprint.route("/api/remote/colab/runtime/stop", methods=["POST"])
def colab_runtime_stop():
    from .colab_backend import existing_runtime

    if (denied := _local_only()) is not None:
        return denied
    runtime = existing_runtime()
    if runtime is not None:
        threading.Thread(target=runtime.stop, args=("stopped by the user",), daemon=True).start()
    return jsonify({**_runtime_payload(_config_store()), "state": "stopping" if runtime else "off"})


@remote_blueprint.route("/api/remote/colab/drive/continue", methods=["POST"])
def colab_drive_continue():
    from .colab_backend import existing_runtime

    if (denied := _local_only()) is not None:
        return denied
    runtime = existing_runtime()
    try:
        if runtime is None:
            raise ColabCLIError("no colab runtime is waiting for drive access", code="drive_not_waiting")
        runtime.continue_drive_auth()
    except ColabCLIError as exc:
        return _error(exc, 409)
    return jsonify(_runtime_payload(_config_store()))


@remote_blueprint.route("/api/remote/settings", methods=["GET", "POST"])
def remote_settings():
    store = _config_store()
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        colab = payload.get("colab") if isinstance(payload.get("colab"), dict) else {}
        try:
            store.update_remote_settings(
                backend=payload.get("backend"),
                colab_gpu=colab.get("gpu"),
                colab_idle_minutes=int(colab["idle_minutes"]) if colab.get("idle_minutes") is not None else None,
                colab_model_cache=colab.get("model_cache"),
            )
        except (TypeError, ValueError) as exc:
            return jsonify({"error": str(exc), "code": "settings_invalid"}), 400
    return jsonify(_settings_payload(store))


__all__ = ["remote_blueprint"]
