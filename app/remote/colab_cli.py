"""Google's Colab CLI (``google-colab-cli``) driven through WSL.

MediaStudio never reads the CLI's OAuth token. Sign-in is the CLI's own copy-paste flow
(it prints a Google URL and reads the code on stdin), and MediaStudio only checks that the
token file exists. MediaStudio keeps its sessions in its own ``--config`` file, so sessions
the user starts with ``colab`` by hand stay out of its way; the account is shared.
"""

from __future__ import annotations

import dataclasses
import json
import queue
import re
import shlex
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from . import wsl

SESSION_DIR = '"$HOME/.config/mediastudio-colab"'
SESSION_CONFIG = '"$HOME/.config/mediastudio-colab/sessions.json"'
# Saved sessions live in a folder named after the product's codename; this moves one left under the old name.
LEGACY_SESSION_DIR = '"$HOME/.config/cmv-colab"'
# The runtime's Jupyter server sometimes takes longer than the kernel client's default 10 s
# to answer; a longer wait avoids the client's retry storm that outlasts our own timeout.
CLI_ENV = {"REQUEST_TIMEOUT": "30"}
EXEC_ATTEMPTS = 3
TOKEN_FILE = '"$HOME/.config/colab-cli/token.json"'
PACKAGE = "google-colab-cli"

# uv from its official installer, then the CLI as a uv tool (both land in ~/.local/bin).
INSTALL_SCRIPT = f"""set -e
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv…"
  if command -v curl >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh
  else wget -qO- https://astral.sh/uv/install.sh | sh; fi
fi
echo "Installing {PACKAGE}…"
uv tool install -U {PACKAGE}
colab version
"""


@dataclass(frozen=True)
class GpuChoice:
    id: str
    label: str
    vram_gb: int
    # Measured on a Google AI Pro account (2026-10-13); the live rate comes from `colab usage`.
    cu_per_hour: float | None
    note: str


GPU_CHOICES: dict[str, GpuChoice] = {
    "G4": GpuChoice("G4", "RTX PRO 6000 Blackwell", 96, 8.90, "Fastest: Krea2 1024² in about 3 s"),
    "A100": GpuChoice("A100", "NVIDIA A100", 40, 5.30, "Fast, mid price"),
    "L4": GpuChoice("L4", "NVIDIA L4", 24, 1.54, "Economy: about 17 s per image, cheap to keep idle"),
    "T4": GpuChoice("T4", "NVIDIA T4", 16, None, "Free tier; Krea2 not tested"),
    "H100": GpuChoice("H100", "NVIDIA H100", 80, None, "Needs a plan with H100 quota"),
}


class ColabCLIError(RuntimeError):
    def __init__(self, message: str, *, code: str = "colab_failed"):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ColabUsage:
    balance: float | None
    rate_per_hour: float | None
    active_assignments: int | None
    # From Colab's ccu-info answer in the CLI's debug log; None when it was not there.
    eligible_gpus: list[str] | None = None
    ineligible_gpus: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ColabSession:
    name: str
    endpoint: str
    hardware: str
    shape: str
    variant: str
    status: str | None = None

    @property
    def busy(self) -> bool:
        return bool(self.status and self.status.startswith("BUSY"))

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "busy": self.busy}


# --- output parsing -----------------------------------------------------------------

_VERSION = re.compile(r"Version:\s*([0-9][\w.+-]*)")
_BALANCE = re.compile(r"Current balance:\s*(-?[\d.]+)")
_RATE = re.compile(r"Usage rate:\s*(-?[\d.]+)\s*/hr")
_ACTIVE = re.compile(r"Active assignments:\s*(\d+)")
_SESSION = re.compile(
    r"^\[(?P<name>[^\]]+)\]\s+(?P<endpoint>\S+)\s*\|\s*Hardware:\s*(?P<hardware>[^|]+?)\s*"
    r"\|\s*Shape:\s*(?P<shape>[^|]+?)\s*\|\s*Variant:\s*(?P<variant>[^|]+?)"
    r"(?:\s*\|\s*Status:\s*(?P<status>.+?))?\s*$"
)
_EMAIL = re.compile(r"^Email:\s*(\S+@\S+)\s*$", re.MULTILINE)
_EXPIRES = re.compile(r"^Expires in:\s*(.+?)\s*$", re.MULTILINE)
_NEWER = re.compile(r"new version of Colab CLI is available:\s*([0-9][\w.+-]*)")
_LOGIN_URL = re.compile(r"https://accounts\.google\.com/\S+")


def parse_version(text: str) -> str | None:
    match = _VERSION.search(text)
    return match.group(1) if match else None


def parse_usage(text: str) -> ColabUsage:
    balance, rate, active = _BALANCE.search(text), _RATE.search(text), _ACTIVE.search(text)
    return ColabUsage(
        balance=float(balance.group(1)) if balance else None,
        rate_per_hour=float(rate.group(1)) if rate else None,
        active_assignments=int(active.group(1)) if active else None,
    )


def parse_gpu_eligibility(text: str) -> tuple[list[str] | None, list[str] | None]:
    """The eligible and ineligible GPUs in a ccu-info JSON body inside the CLI's debug log."""
    for line in text.splitlines():
        start = line.find("{")
        if "eligibleGpus" not in line or start < 0:
            continue
        try:
            body = json.loads(line[start:])
        except ValueError:
            continue
        eligible, ineligible = body.get("eligibleGpus"), body.get("ineligibleGpus")
        if isinstance(eligible, list):
            return [str(item).upper() for item in eligible], [str(item).upper() for item in ineligible or []]
    return None, None


def parse_sessions(text: str) -> list[ColabSession]:
    sessions: list[ColabSession] = []
    for line in text.splitlines():
        match = _SESSION.match(line.strip())
        if match:
            sessions.append(ColabSession(**{key: value for key, value in match.groupdict().items()}))
    return sessions


def parse_whoami(text: str) -> dict[str, str | None]:
    email, expires = _EMAIL.search(text), _EXPIRES.search(text)
    return {"email": email.group(1) if email else None, "expires_in": expires.group(1) if expires else None}


def parse_newer_version(text: str) -> str | None:
    match = _NEWER.search(text)
    return match.group(1) if match else None


def _stalled(result: subprocess.CompletedProcess[str]) -> bool:
    """The CLI gave up reaching the runtime (not the code failing): worth another try."""
    text = result.stdout + result.stderr
    return any(marker in text for marker in ("ReadTimeout", "Read timed out", "ConnectTimeout", "Timeout waiting for reply"))


# The frames the CLI draws its error panels with.
_BOX_DRAWING = re.compile("[\u2500-\u257f]+")


def _tail(result: subprocess.CompletedProcess[str], limit: int = 400) -> str:
    """The last lines of the CLI's output, without the frames of its error panels."""
    lines = []
    for raw in (result.stderr + "\n" + result.stdout).splitlines():
        line = " ".join(_BOX_DRAWING.sub(" ", raw).split())
        if line:
            lines.append(line)
    return " ".join(lines[-3:])[-limit:] or f"exit {result.returncode}"


Runner = Callable[..., subprocess.CompletedProcess[str]]
Starter = Callable[..., subprocess.Popen[bytes]]


class ColabCLI:
    def __init__(
        self,
        *,
        runner: Runner = wsl.run,
        starter: Starter = wsl.popen,
        path_mapper: Callable[[str | Path], str] = wsl.to_wsl_path,
    ):
        self._run = runner
        self._start = starter
        self._map_path = path_mapper

    # --- commands -------------------------------------------------------------------

    @staticmethod
    def command(*args: str) -> str:
        quoted = " ".join(shlex.quote(str(arg)) for arg in args)
        migrate = f"if [ -d {LEGACY_SESSION_DIR} ] && [ ! -e {SESSION_DIR} ]; then mv {LEGACY_SESSION_DIR} {SESSION_DIR}; fi"
        return f"{migrate}; mkdir -p {SESSION_DIR} && exec colab --auth oauth2 --config {SESSION_CONFIG} {quoted}"

    def _call(self, *args: str, timeout: float = 60.0, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        try:
            return self._run(self.command(*args), timeout=timeout, input_text=input_text, env=CLI_ENV)
        except wsl.WslError as exc:
            raise ColabCLIError(str(exc), code="wsl_unavailable") from exc

    def version(self) -> str | None:
        result = self._run("command -v colab >/dev/null 2>&1 && colab version", timeout=30.0)
        return parse_version(result.stdout) if result.returncode == 0 else None

    def newer_version(self) -> str | None:
        """The newer release the CLI knows about (its own update check), else None."""
        result = self._run("colab update", timeout=60.0)
        return parse_newer_version(result.stdout + result.stderr)

    def token_present(self) -> bool:
        """Whether the CLI has a saved sign-in; the file is tested, never read."""
        return self._run(f"test -s {TOKEN_FILE}", timeout=30.0).returncode == 0

    def whoami(self) -> dict[str, str | None] | None:
        """The signed-in account, or None; never starts the sign-in flow."""
        if not self.token_present():
            return None
        # stdin is closed: a token that cannot be refreshed fails instead of waiting for a code.
        result = self._call("whoami", timeout=60.0)
        info = parse_whoami(result.stdout)
        return info if result.returncode == 0 and info["email"] else None

    def logout(self) -> None:
        self._run(f"rm -f {TOKEN_FILE}", timeout=30.0)

    def usage(self) -> ColabUsage:
        # --logtostderr exposes Colab's answer, which also names the GPUs this plan may use.
        result = self._call("--logtostderr", "usage", timeout=90.0)
        usage = parse_usage(result.stdout)
        if result.returncode != 0 or usage.balance is None:
            raise ColabCLIError(f"Colab usage is unavailable: {_tail(result)}", code="usage_failed")
        eligible, ineligible = parse_gpu_eligibility(result.stderr)
        return dataclasses.replace(usage, eligible_gpus=eligible, ineligible_gpus=ineligible)

    def sessions(self) -> list[ColabSession]:
        result = self._call("sessions", timeout=90.0)
        if result.returncode != 0:
            raise ColabCLIError(f"Colab sessions are unavailable: {_tail(result)}", code="sessions_failed")
        return parse_sessions(result.stdout)

    def status(self, name: str) -> ColabSession | None:
        result = self._call("status", "-s", name, timeout=60.0)
        found = [item for item in parse_sessions(result.stdout) if item.name == name]
        return found[0] if found else None

    def new(self, name: str, gpu: str | None) -> None:
        args = ["new", "-s", name, *(["--gpu", gpu] if gpu else [])]
        result = self._call(*args, timeout=300.0)
        if result.returncode == 0 and "Session READY" in result.stdout:
            return
        text = result.stdout + result.stderr
        if "rejected accelerator" in text:
            raise ColabCLIError(f"Your Colab plan has no {gpu} available right now.", code="gpu_rejected")
        if "Allocation refused" in text:
            raise ColabCLIError(
                "Colab refused the runtime: too many sessions or a temporary capacity limit.",
                code="allocation_refused",
            )
        if _stalled(result):
            raise ColabCLIError(
                "Colab did not answer in time. Check that WSL can reach the internet (a VPN often "
                "blocks it), then try again.",
                code="colab_unreachable",
            )
        raise ColabCLIError(f"Colab could not start a runtime: {_tail(result)}")

    def stop(self, name: str) -> bool:
        result = self._call("stop", "-s", name, timeout=120.0)
        return result.returncode == 0 and "terminated" in result.stdout

    def upload(self, name: str, local: str | Path, remote: str) -> None:
        result = self._call("upload", "-s", name, self._map_path(local), remote, timeout=600.0)
        if result.returncode != 0:
            raise ColabCLIError(f"Upload to Colab failed: {_tail(result)}", code="upload_failed")

    def start_drive_mount(self, name: str) -> subprocess.Popen[bytes]:
        """Mount Drive while keeping stdin available for Google's access confirmation."""
        try:
            return self._start(self.command("drivemount", "-s", name, "/content/drive"), env=CLI_ENV)
        except wsl.WslError as exc:
            raise ColabCLIError("cannot start google drive connection", code="drive_mount_failed") from exc

    def download(self, name: str, remote: str, local: str | Path) -> None:
        Path(local).parent.mkdir(parents=True, exist_ok=True)
        result = self._call("download", "-s", name, remote, self._map_path(local), timeout=600.0)
        if result.returncode != 0:
            raise ColabCLIError(f"Download from Colab failed: {_tail(result)}", code="download_failed")

    def exec_code(
        self, name: str, code: str, *, timeout: float = 120.0, attempts: int = EXEC_ATTEMPTS,
    ) -> subprocess.CompletedProcess[str]:
        """Run a short, repeatable Python snippet in the session kernel and wait for it.

        A connection that stalls (the CLI waiting on the runtime's Jupyter server) is tried
        again, so callers must only send code that is safe to run twice.
        """
        last: subprocess.CompletedProcess[str] | ColabCLIError | None = None
        for attempt in range(max(1, attempts)):
            if attempt:
                time.sleep(3 * attempt)
            try:
                result = self._call("exec", "-s", name, "--timeout", str(int(timeout)), timeout=timeout + 90.0, input_text=code)
            except ColabCLIError as exc:
                last = exc
                continue
            if result.returncode == 0 or not _stalled(result):
                return result
            last = result
        if isinstance(last, ColabCLIError):
            raise last
        assert last is not None
        return last

    def exec_stream(self, name: str, code: str, *, timeout: float) -> subprocess.Popen[bytes]:
        """Run Python in the session kernel and stream its output (the caller reads stdout)."""
        try:
            process = self._start(self.command("exec", "-s", name, "--timeout", str(int(timeout))), env=CLI_ENV)
        except wsl.WslError as exc:
            raise ColabCLIError(str(exc), code="wsl_unavailable") from exc
        assert process.stdin is not None
        process.stdin.write(code.encode("utf-8"))
        process.stdin.close()
        return process

    def start_login(self) -> LoginFlow:
        """Start the CLI's sign-in: it asks for the Google code when there is no valid token."""
        try:
            return LoginFlow(self._start(self.command("sessions")))
        except wsl.WslError as exc:
            raise ColabCLIError(str(exc), code="wsl_unavailable") from exc

    def start_install(self) -> subprocess.Popen[bytes]:
        try:
            process = self._start(INSTALL_SCRIPT)
        except wsl.WslError as exc:
            raise ColabCLIError(str(exc), code="wsl_unavailable") from exc
        if process.stdin is not None:
            process.stdin.close()
        return process


class LoginFlow:
    """The CLI's copy-paste OAuth: a Google URL on stderr, then the code on stdin."""

    def __init__(self, process: subprocess.Popen[bytes]):
        self.process = process
        self.url: str | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._output: list[str] = []
        self._readers = [
            threading.Thread(target=self._read, args=(stream,), daemon=True, name="mediastudio-colab-login")
            for stream in (process.stderr, process.stdout)
            if stream is not None
        ]
        for reader in self._readers:
            reader.start()

    def _read(self, stream: Any) -> None:
        for raw in iter(stream.readline, b""):
            self._lines.put(wsl.decode_output(raw).rstrip())
        self._lines.put(None)

    def wait_for_url(self, timeout: float = 90.0) -> str | None:
        """The sign-in URL; None when the CLI finished without asking (already signed in)."""
        deadline = time.monotonic() + timeout
        finished = 0
        while time.monotonic() < deadline:
            try:
                line = self._lines.get(timeout=0.25)
            except queue.Empty:
                continue
            if line is None:
                finished += 1
                if finished == len(self._readers):
                    return None
                continue
            self._output.append(line)
            match = _LOGIN_URL.search(line)
            if match:
                self.url = match.group(0)
                return self.url
        raise ColabCLIError("The Colab CLI did not show a sign-in link in time.", code="login_timeout")

    def submit(self, code: str, timeout: float = 90.0) -> bool:
        """Hand the code to the CLI; True when it signed in."""
        if self.process.stdin is None or self.process.poll() is not None:
            raise ColabCLIError("The sign-in has already ended; start it again.", code="login_expired")
        self.process.stdin.write(code.strip().encode("utf-8") + b"\n")
        self.process.stdin.close()
        try:
            return self.process.wait(timeout=timeout) == 0
        except subprocess.TimeoutExpired:
            self.cancel()
            raise ColabCLIError("The Colab CLI did not finish signing in.", code="login_timeout") from None

    def cancel(self) -> None:
        if self.process.poll() is None:
            self.process.kill()

    @property
    def output(self) -> str:
        return "\n".join(self._output)


__all__ = [
    "GPU_CHOICES",
    "INSTALL_SCRIPT",
    "ColabCLI",
    "ColabCLIError",
    "ColabSession",
    "ColabUsage",
    "GpuChoice",
    "LoginFlow",
    "parse_gpu_eligibility",
    "parse_newer_version",
    "parse_sessions",
    "parse_usage",
    "parse_version",
    "parse_whoami",
]
