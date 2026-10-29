from __future__ import annotations

import subprocess
import sys

import pytest

from app.config_store import ConfigStore
from app.main import app
from app.remote import colab_cli, routes, wsl
from app.remote.colab_cli import ColabCLI, ColabCLIError, LoginFlow

# Recorded from google-colab-cli 0.7.4 (2026-10-13); the email is made up.
USAGE = "Current balance: 350.96 compute units\nUsage rate: 8.90/hr\nActive assignments: 1\n"
SESSIONS = (
    "[colab] Pruned 1 stale local session(s).\n"
    "[mediastudio-g4] gpu-g4-s-ft-kkb-euw4a1-1b1bb5wnohfuv | Hardware: G4 | Shape: Standard | Variant: GPU\n"
    "[?] m-s-kkb-usw1c2-1epnzlci1x1j3 | Hardware: CPU | Shape: Standard | Variant: DEFAULT\n"
)
STATUS = (
    "[mediastudio-g4] gpu-g4-s-ft-kkb-euw4a1-1b1bb5wnohfuv | Hardware: G4 | Shape: Standard | Variant: GPU"
    " | Status: BUSY (relay)\n  Last Execution: <stdin> at 2026-10-13 01:28:14\n"
)
WHOAMI = (
    "Auth provider: oauth2\nEmail:         someone@example.com\n"
    "Audience:      764086051850-x.apps.googleusercontent.com\nExpires in:    59m\nScopes:\n  - email\n"
)


CCU_LOG = (
    "2026-10-13 02:55:12,820 - colab_cli.client - DEBUG - Response Body: )]}'\n"
    '{"currentBalance":348.84, "consumptionRateHourly":0, "assignmentsCount":0, "eligibleGpus":["G4", "A100", "L4", "T4"], '
    '"ineligibleGpus":["H100"], "eligibleTpus":["V6E1", "V5E1"]}\n'
)


def test_gpu_eligibility_comes_from_the_debug_log():
    assert colab_cli.parse_gpu_eligibility(CCU_LOG) == (["G4", "A100", "L4", "T4"], ["H100"])
    assert colab_cli.parse_gpu_eligibility("no json here") == (None, None)
    cli, runner = _cli({" usage": (0, USAGE, CCU_LOG)})
    usage = cli.usage()
    assert usage.eligible_gpus == ["G4", "A100", "L4", "T4"] and usage.ineligible_gpus == ["H100"]
    assert "--logtostderr usage" in runner.scripts[-1]


def test_parsers_read_recorded_cli_output():
    assert colab_cli.parse_version("Version: 0.7.4\n") == "0.7.4"
    usage = colab_cli.parse_usage(USAGE)
    assert (usage.balance, usage.rate_per_hour, usage.active_assignments) == (350.96, 8.9, 1)
    sessions = colab_cli.parse_sessions(SESSIONS)
    assert [(item.name, item.hardware, item.variant) for item in sessions] == [
        ("mediastudio-g4", "G4", "GPU"), ("?", "CPU", "DEFAULT"),
    ]
    (status,) = colab_cli.parse_sessions(STATUS)
    assert status.status == "BUSY (relay)" and status.busy
    assert colab_cli.parse_whoami(WHOAMI) == {"email": "someone@example.com", "expires_in": "59m"}
    assert colab_cli.parse_newer_version("[colab] A new version of Colab CLI is available: 0.7.4 (current: 0.6.0)") == "0.7.4"
    assert colab_cli.parse_newer_version("") is None


class _Runner:
    """Answers scripted CLI calls by the first matching fragment of the script."""

    def __init__(self, answers: dict[str, tuple[int, str, str]]):
        self.answers = answers
        self.scripts: list[str] = []
        self.inputs: list[str | None] = []
        self.envs: list[dict | None] = []

    def __call__(self, script, *, timeout=30.0, input_text=None, env=None):
        self.scripts.append(script)
        self.inputs.append(input_text)
        self.envs.append(env)
        for fragment, answer in self.answers.items():
            if fragment in script:
                code, out, err = answer.pop(0) if isinstance(answer, list) else answer
                return subprocess.CompletedProcess(["wsl"], code, out, err)
        return subprocess.CompletedProcess(["wsl"], 1, "", "unexpected")


def _cli(answers):
    runner = _Runner(answers)
    return ColabCLI(runner=runner, starter=lambda script, env=None: None, path_mapper=lambda path: f"/mnt/x/{path}"), runner


def test_commands_use_oauth_and_mediastudio_own_session_file():
    command = ColabCLI.command("new", "-s", "mediastudio one", "--gpu", "G4")
    assert "colab --auth oauth2 --config \"$HOME/.config/mediastudio-colab/sessions.json\"" in command
    assert "new -s 'mediastudio one' --gpu G4" in command


def test_whoami_never_starts_sign_in_without_a_token():
    cli, runner = _cli({"test -s": (1, "", "")})
    assert cli.whoami() is None
    assert not any(" whoami" in script for script in runner.scripts)


def test_whoami_reads_the_account():
    cli, _ = _cli({"test -s": (0, "", ""), "whoami": (0, WHOAMI, "")})
    assert cli.whoami() == {"email": "someone@example.com", "expires_in": "59m"}


@pytest.mark.parametrize(("stderr", "code"), [
    ("[colab] Backend rejected accelerator 'H100'. You may not have quota", "gpu_rejected"),
    ("[colab] Allocation refused (precondition failed).", "allocation_refused"),
    ("Traceback: boom", "colab_failed"),
    ("ReadTimeout: HTTPSConnectionPool(host='colab.research.google.com', port=443): Read timed out.", "colab_unreachable"),
])
def test_new_explains_refused_runtimes(stderr, code):
    cli, _ = _cli({" new ": (1, "[colab] Creating session 'mediastudio'...\n", stderr)})
    with pytest.raises(ColabCLIError) as excinfo:
        cli.new("mediastudio", "H100")
    assert excinfo.value.code == code


def test_cli_errors_lose_the_frames_of_rich_panels():
    panel = "╭" + "─" * 300 + "╮\n│ KeyError: 'endpoint' │\n╰" + "─" * 300 + "╯"
    cli, _ = _cli({" new ": (1, "[colab] Creating session 'mediastudio'...\n", panel)})
    with pytest.raises(ColabCLIError) as excinfo:
        cli.new("mediastudio", "G4")
    message = str(excinfo.value)
    assert "─" not in message and "KeyError: 'endpoint'" in message and len(message) < 200


def test_new_succeeds_on_ready():
    cli, runner = _cli({" new ": (0, "[colab] Creating session 'mediastudio'...\n[colab] Session READY.\n", "")})
    cli.new("mediastudio", "G4")
    assert "--gpu G4" in runner.scripts[-1]


def test_usage_without_a_balance_is_an_error():
    cli, _ = _cli({" usage": (1, "", "[colab] Warning: failed to fetch compute-unit info: 401")})
    with pytest.raises(ColabCLIError) as excinfo:
        cli.usage()
    assert excinfo.value.code == "usage_failed"


def test_files_and_exec_map_paths_and_pass_code_on_stdin(tmp_path):
    cli, runner = _cli({" upload ": (0, "", ""), " exec ": (0, "ok\n", "")})
    cli.upload("mediastudio", tmp_path / "job.json", "/content/mediastudio/inbox/job.json")
    assert f"/mnt/x/{tmp_path / 'job.json'}" in runner.scripts[-1]
    cli.exec_code("mediastudio", "print('ok')", timeout=90)
    assert "--timeout 90" in runner.scripts[-1]
    assert runner.inputs[-1] == "print('ok')"


FAKE_LOGIN = """
import sys
print("\\nTo authorize colab-cli, visit this URL in any browser:\\n", file=sys.stderr, flush=True)
print("  https://accounts.google.com/o/oauth2/auth?client_id=x&state=y\\n", file=sys.stderr, flush=True)
code = input("Enter the authorization code: ").strip()
sys.exit(0 if code == "good-code" else 3)
"""


def _login_process(script: str) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [sys.executable, "-c", script],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


@pytest.mark.parametrize(("code", "signed_in"), [("good-code", True), ("bad", False)])
def test_login_flow_finds_the_link_and_hands_over_the_code(code, signed_in):
    flow = LoginFlow(_login_process(FAKE_LOGIN))
    assert flow.wait_for_url(timeout=20) == "https://accounts.google.com/o/oauth2/auth?client_id=x&state=y"
    assert flow.submit(code, timeout=20) is signed_in


def test_login_flow_without_a_link_means_already_signed_in():
    flow = LoginFlow(_login_process("print('[colab] No active sessions found on server.')"))
    assert flow.wait_for_url(timeout=20) is None


def test_wsl_passes_the_script_through_the_environment():
    env = wsl._environment("echo 'hi there'", {"EXTRA": "1"})
    assert env[wsl.SCRIPT_VARIABLE] == "echo 'hi there'"
    shared = env["WSLENV"].split(":")
    assert f"{wsl.SCRIPT_VARIABLE}/u" in shared and "EXTRA/u" in shared
    assert wsl.decode_output("Ubuntu\r\n".encode("utf-16-le")).strip() == "Ubuntu"
    assert wsl.decode_output("кириллица".encode()) == "кириллица"


def test_remote_settings_are_normalized_and_validated(tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    assert store.remote_settings() == {"backend": "local", "colab": {"gpu": "G4", "idle_minutes": 10, "model_cache": False}}
    store.update_remote_settings(backend="colab", colab_gpu="l4", colab_idle_minutes=2)
    assert store.remote_settings() == {"backend": "colab", "colab": {"gpu": "L4", "idle_minutes": 2, "model_cache": False}}
    for kwargs in ({"colab_idle_minutes": 1}, {"colab_idle_minutes": 61}, {"colab_gpu": "V100"}, {"backend": "cloud"}):
        with pytest.raises(ValueError):
            store.update_remote_settings(**kwargs)
    # Other sections survive a save of remote settings, and remote survives other saves.
    store.update_comfyui_settings(port=8190)
    assert store.remote_settings()["colab"]["gpu"] == "L4"
    assert store.comfyui_settings()["port"] == 8190


@pytest.fixture
def remote_client(tmp_path, monkeypatch):
    store = ConfigStore(tmp_path / "config.json")
    monkeypatch.setitem(app.config, "CONFIG_STORE", store)
    monkeypatch.setattr(routes, "_status_cache", None)
    return app.test_client()


def test_settings_route_validates_idle_minutes(remote_client):
    assert remote_client.post("/api/remote/settings", json={"colab": {"idle_minutes": 90}}).status_code == 400
    data = remote_client.post("/api/remote/settings", json={"colab": {"gpu": "A100", "idle_minutes": 25}}).get_json()
    assert data["colab"] == {"gpu": "A100", "idle_minutes": 25, "model_cache": False}
    assert data["idle_minutes_range"] == [2, 60]
    assert data["gpus"][0]["id"] == "G4"


def test_status_without_wsl_skips_the_cli(remote_client, monkeypatch):
    monkeypatch.setattr(wsl, "status", lambda: wsl.WslStatus(False, None, "WSL is not installed."))
    monkeypatch.setattr(routes, "_cli", lambda: pytest.fail("the CLI was called without WSL"))
    data = remote_client.get("/api/remote/colab/status").get_json()
    assert data["wsl"]["available"] is False
    assert data["cli"]["installed"] is False and data["account"]["signed_in"] is False


def test_status_reports_the_signed_in_account(remote_client, monkeypatch):
    cli, _ = _cli({"colab version": (0, "Version: 0.7.4\n", ""), "test -s": (0, "", ""), "whoami": (0, WHOAMI, "")})
    monkeypatch.setattr(wsl, "status", lambda: wsl.WslStatus(True, "Ubuntu"))
    monkeypatch.setattr(routes, "_cli", lambda: cli)
    data = remote_client.get("/api/remote/colab/status").get_json()
    assert data["cli"] == {"installed": True, "version": "0.7.4"}
    assert data["account"]["email"] == "someone@example.com"


def test_status_is_cached_until_a_refresh(remote_client, monkeypatch):
    calls = []

    def status():
        calls.append(1)
        return wsl.WslStatus(False, None, "WSL is not installed.")

    monkeypatch.setattr(wsl, "status", status)
    remote_client.get("/api/remote/colab/status")
    remote_client.get("/api/remote/colab/status")
    assert len(calls) == 1
    remote_client.get("/api/remote/colab/status?refresh=1")
    assert len(calls) == 2
    routes._forget_status()
    remote_client.get("/api/remote/colab/status")
    assert len(calls) == 3


def test_code_without_a_pending_sign_in_is_refused(remote_client, monkeypatch):
    monkeypatch.setattr(routes, "_login", None)
    resp = remote_client.post("/api/remote/colab/login/code", json={"code": "abc"})
    assert resp.status_code == 409
    assert resp.get_json()["code"] == "login_not_started"


def test_process_starting_routes_answer_only_this_computer(remote_client):
    for path in ("/api/remote/colab/install", "/api/remote/colab/login", "/api/remote/wsl/install", "/api/remote/colab/logout"):
        resp = remote_client.post(path, environ_base={"REMOTE_ADDR": "192.168.1.20"})
        assert resp.status_code == 403, path
        assert resp.get_json()["code"] == "local_only"


def test_exec_retries_a_stalled_connection_but_not_a_failing_snippet(monkeypatch):
    monkeypatch.setattr(colab_cli.time, "sleep", lambda seconds: None)
    stalled = (1, "", "requests.exceptions.ReadTimeout: Read timed out. (read timeout=30)")
    cli, runner = _cli({" exec ": [stalled, (0, "ok\n", "")]})
    assert cli.exec_code("mediastudio", "print('ok')").stdout == "ok\n"
    assert len(runner.scripts) == 2
    assert runner.envs[-1] == {"REQUEST_TIMEOUT": "30"}

    cli, runner = _cli({" exec ": [(1, "", "NameError: name 'x' is not defined"), (0, "", "")]})
    assert cli.exec_code("mediastudio", "x").returncode == 1
    assert len(runner.scripts) == 1


def test_model_cache_setting_is_persisted_and_requires_boolean(remote_client):
    response = remote_client.post("/api/remote/settings", json={"colab": {"model_cache": True}})
    assert response.status_code == 200
    assert remote_client.get("/api/remote/settings").get_json()["colab"]["model_cache"] is True
    assert remote_client.post("/api/remote/settings", json={"colab": {"model_cache": "false"}}).status_code == 400



def test_drive_confirmation_requires_pending_runtime(remote_client, monkeypatch):
    from app.remote import colab_backend
    monkeypatch.setattr(colab_backend, "existing_runtime", lambda: None)
    assert remote_client.post("/api/remote/colab/drive/continue").status_code == 409
