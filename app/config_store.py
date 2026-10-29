from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .paths import normalize_path

CONFIG_VERSION = 3
_config_lock = threading.RLock()

# Where Create runs its graphs, and the Colab remote GPU settings (docs/COLAB-REMOTE-PLAN.md).
REMOTE_BACKENDS = ("local", "colab")
COLAB_GPUS = ("G4", "A100", "L4", "T4", "H100")
DEFAULT_COLAB_GPU = "G4"
IDLE_MINUTES_MIN, IDLE_MINUTES_MAX, DEFAULT_IDLE_MINUTES = 2, 60, 10


class ConfigStoreError(RuntimeError):
    """Raised when the persistent application configuration cannot be used."""


@dataclass(frozen=True)
class SourceSettings:
    path: Path
    name: str
    enabled: bool = True
    recursive: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "name": self.name,
            "enabled": self.enabled,
            "recursive": self.recursive,
        }


def _remote_settings(raw: Any) -> dict[str, Any]:
    remote = raw if isinstance(raw, dict) else {}
    colab = remote.get("colab") if isinstance(remote.get("colab"), dict) else {}
    backend = remote.get("backend")
    gpu = str(colab.get("gpu") or "").upper()
    try:
        idle = int(colab.get("idle_minutes"))
    except (TypeError, ValueError):
        idle = DEFAULT_IDLE_MINUTES
    return {
        "backend": backend if backend in REMOTE_BACKENDS else "local",
        "colab": {
            "gpu": gpu if gpu in COLAB_GPUS else DEFAULT_COLAB_GPU,
            "idle_minutes": min(IDLE_MINUTES_MAX, max(IDLE_MINUTES_MIN, idle)),
            "model_cache": colab.get("model_cache") is True,
        },
    }


def _ai_settings(raw: Any) -> dict[str, Any]:
    """Integrations › Providers and Models (app/ai/providers.py).

    ``providers`` is None in a file written before providers replaced the AI profiles;
    the legacy ``profiles`` and default profile ids are kept only until they migrate.
    """
    ai = raw if isinstance(raw, dict) else {}
    raw_providers = ai.get("providers")
    providers = (
        [dict(item) for item in raw_providers if isinstance(item, dict)]
        if isinstance(raw_providers, list)
        else None
    )
    tools = ai.get("tools") if isinstance(ai.get("tools"), dict) else {}
    disconnected = tools.get("disconnected")
    models = ai.get("models") if isinstance(ai.get("models"), dict) else {}
    visibility = models.get("visibility")
    default_model = ai.get("default_model")
    defaults = ai.get("defaults") if isinstance(ai.get("defaults"), dict) else {}
    settings: dict[str, Any] = {
        "providers": providers,
        "tools": {
            "disconnected": [
                item for item in disconnected if isinstance(item, str)
            ] if isinstance(disconnected, list) else [],
        },
        "models": {
            "visibility": {
                key: value for key, value in visibility.items()
                if isinstance(key, str) and isinstance(value, bool)
            } if isinstance(visibility, dict) else {},
        },
        "default_model": dict(default_model) if isinstance(default_model, dict) else None,
        "defaults": {"rating_auto_enabled": bool(defaults.get("rating_auto_enabled", False))},
    }
    if providers is None:
        raw_profiles = ai.get("profiles")
        settings["profiles"] = (
            [dict(item) for item in raw_profiles if isinstance(item, dict)]
            if isinstance(raw_profiles, list)
            else []
        )
        for key in ("text_profile_id", "translator_profile_id", "multimodal_profile_id"):
            settings["defaults"][key] = defaults.get(key)
    return settings


def _default_config() -> dict[str, Any]:
    return {
        "version": CONFIG_VERSION,
        "sources": [],
        "ai": _ai_settings({"providers": []}),
        "comfyui": {
            "install_path": None,
            "custom_python": None,
            "desktop_installation_id": None,
            "models_dir": None,
            "input_dir": None,
            "output_dir": None,
            "host": "127.0.0.1",
            "port": 8188,
            "extra_args": "",
            "auto_start": False,
            "civitai_api_token": None,
        },
        "social": {
            "telegram": {
                "api_id": None,
                "api_hash": None,
            },
            "vk": {
                "client_id": None,
                "client_secret": None,
            },
        },
        "remote": _remote_settings(None),
    }


class ConfigStore:
    """Persist durable app settings separately from the disposable SQLite index."""

    def __init__(self, path: str | Path):
        self.path = normalize_path(path)
        self.temporary_path = self.path.with_suffix(f"{self.path.suffix}.tmp")

    def load(self) -> dict[str, Any]:
        with _config_lock:
            if not self.path.exists():
                return _default_config()
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise ConfigStoreError(
                    f"Cannot read application configuration: {self.path}: {exc}"
                ) from exc

            if not isinstance(raw, dict) or raw.get("version") not in (
                1,
                2,
                CONFIG_VERSION,
            ):
                raise ConfigStoreError(
                    f"Unsupported application configuration: {self.path}"
                )

            raw_sources = raw.get("sources", [])
            if not isinstance(raw_sources, list):
                raise ConfigStoreError(
                    f"Invalid source list in application configuration: {self.path}"
                )

            sources: list[dict[str, Any]] = []
            seen: set[str] = set()
            for item in raw_sources:
                if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                    continue
                normalized = str(normalize_path(item["path"]))
                if normalized in seen:
                    continue
                seen.add(normalized)
                default_name = Path(normalized).name or normalized
                sources.append({
                    "path": normalized,
                    "name": (
                        item["name"].strip()
                        if isinstance(item.get("name"), str) and item["name"].strip()
                        else default_name
                    ),
                    "enabled": item.get("enabled", item.get("active", True)) is not False,
                    "recursive": item.get("recursive") is True,
                })

            raw_comfyui = raw.get("comfyui")
            comfyui = raw_comfyui if isinstance(raw_comfyui, dict) else {}

            raw_social = raw.get("social")
            social = raw_social if isinstance(raw_social, dict) else {}
            social_telegram = social.get("telegram")
            social_telegram = (
                social_telegram if isinstance(social_telegram, dict) else {}
            )
            social_vk = social.get("vk")
            social_vk = social_vk if isinstance(social_vk, dict) else {}

            return {
                "version": CONFIG_VERSION,
                "sources": sources,
                "ai": _ai_settings(raw.get("ai")),
                "comfyui": {
                    "install_path": comfyui.get("install_path"),
                    "custom_python": comfyui.get("custom_python"),
                    "desktop_installation_id": comfyui.get("desktop_installation_id"),
                    # MediaStudio's own folders over Desktop's; None follows Desktop.
                    "models_dir": comfyui.get("models_dir"),
                    "input_dir": comfyui.get("input_dir"),
                    "output_dir": comfyui.get("output_dir"),
                    "host": comfyui.get("host") or "127.0.0.1",
                    "port": int(comfyui.get("port") or 8188),
                    "extra_args": comfyui.get("extra_args") or "",
                    "auto_start": comfyui.get("auto_start") is True,
                    "civitai_api_token": comfyui.get("civitai_api_token"),
                },
                "social": {
                    "telegram": {
                        "api_id": social_telegram.get("api_id"),
                        "api_hash": social_telegram.get("api_hash"),
                    },
                    "vk": {
                        "client_id": social_vk.get("client_id"),
                        "client_secret": social_vk.get("client_secret"),
                    },
                },
                "remote": _remote_settings(raw.get("remote")),
            }

    def save(self, config: dict[str, Any]) -> None:
        with _config_lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
            try:
                with self.temporary_path.open("w", encoding="utf-8", newline="\n") as file:
                    file.write(payload)
                    file.flush()
                    os.fsync(file.fileno())
                self.temporary_path.replace(self.path)
            except OSError as exc:
                raise ConfigStoreError(
                    f"Cannot save application configuration: {self.path}: {exc}"
                ) from exc

    def active_sources(self) -> list[Path]:
        return [
            normalize_path(item["path"])
            for item in self.load()["sources"]
            if item["enabled"]
        ]

    def sources(self) -> list[SourceSettings]:
        return [
            SourceSettings(
                path=normalize_path(item["path"]),
                name=item["name"],
                enabled=item["enabled"],
                recursive=item["recursive"],
            )
            for item in self.load()["sources"]
        ]

    def add_sources(
        self,
        paths: Iterable[str | Path],
        *,
        reactivate: bool = True,
    ) -> None:
        with _config_lock:
            config = self.load()
            sources = config["sources"]
            existing = {item["path"]: item for item in sources}
            changed = False
            for path in paths:
                normalized = str(normalize_path(path))
                if normalized in existing:
                    if reactivate and not existing[normalized]["enabled"]:
                        existing[normalized]["enabled"] = True
                        changed = True
                    continue
                item = SourceSettings(
                    path=Path(normalized),
                    name=Path(normalized).name or normalized,
                ).to_dict()
                sources.append(item)
                existing[normalized] = item
                changed = True
            if changed:
                self.save(config)

    def add_source(
        self,
        path: str | Path,
        *,
        name: str | None = None,
        recursive: bool = False,
    ) -> SourceSettings:
        normalized = normalize_path(path)
        with _config_lock:
            config = self.load()
            sources = config["sources"]
            item = next(
                (entry for entry in sources if entry["path"] == str(normalized)),
                None,
            )
            source_name = (name or "").strip() or normalized.name or str(normalized)
            if item is None:
                item = SourceSettings(
                    path=normalized,
                    name=source_name,
                    recursive=recursive,
                ).to_dict()
                sources.append(item)
            else:
                item.update({
                    "name": source_name if name is not None else item["name"],
                    "enabled": True,
                    "recursive": recursive,
                })
            self.save(config)
        return SourceSettings(
            path=normalized,
            name=item["name"],
            enabled=True,
            recursive=item["recursive"],
        )

    def update_source(
        self,
        path: str | Path,
        *,
        name: str | None = None,
        enabled: bool | None = None,
        recursive: bool | None = None,
    ) -> SourceSettings | None:
        normalized = str(normalize_path(path))
        with _config_lock:
            config = self.load()
            item = next(
                (entry for entry in config["sources"] if entry["path"] == normalized),
                None,
            )
            if item is None:
                return None
            if name is not None:
                item["name"] = name.strip()
            if enabled is not None:
                item["enabled"] = enabled
            if recursive is not None:
                item["recursive"] = recursive
            self.save(config)
            return SourceSettings(
                path=Path(item["path"]),
                name=item["name"],
                enabled=item["enabled"],
                recursive=item["recursive"],
            )

    def remove_source(self, path: str | Path) -> bool:
        normalized = str(normalize_path(path))
        with _config_lock:
            config = self.load()
            sources = config["sources"]
            kept = [item for item in sources if item["path"] != normalized]
            if len(kept) == len(sources):
                return False
            config["sources"] = kept
            self.save(config)
            return True

    def remove_source_for_index_path(self, path: str | Path) -> bool:
        """Remove a source represented by a normal or derived no-metadata folder."""
        normalized = str(normalize_path(path))
        with _config_lock:
            config = self.load()
            sources = config["sources"]
            kept = [
                item
                for item in sources
                if normalized not in (item["path"], f"{item['path']} (no metadata)")
            ]
            if len(kept) == len(sources):
                return False
            config["sources"] = kept
            self.save(config)
            return True

    def delete(self) -> None:
        with _config_lock:
            errors: list[str] = []
            for path in (self.temporary_path, self.path):
                try:
                    path.unlink(missing_ok=True)
                except OSError as exc:
                    errors.append(f"{path}: {exc}")
            if errors:
                raise ConfigStoreError(
                    "Cannot delete application configuration: " + "; ".join(errors)
                )

    def comfyui_settings(self) -> dict[str, Any]:
        settings = self.load().get("comfyui", {
            "install_path": None,
            "custom_python": None,
            "desktop_installation_id": None,
            "models_dir": None,
            "input_dir": None,
            "output_dir": None,
            "host": "127.0.0.1",
            "port": 8188,
            "extra_args": "",
            "auto_start": False,
            "civitai_api_token": None,
        })
        settings.setdefault("civitai_api_token", None)
        for key in ("desktop_installation_id", "models_dir", "input_dir", "output_dir"):
            settings.setdefault(key, None)
        return settings

    def update_comfyui_settings(
        self,
        *,
        install_path: str | None = None,
        custom_python: str | None = None,
        host: str | None = None,
        port: int | None = None,
        extra_args: str | None = None,
        auto_start: bool | None = None,
        civitai_api_token: str | None = None,
        desktop_installation_id: str | None = None,
        models_dir: str | None = None,
        input_dir: str | None = None,
        output_dir: str | None = None,
    ) -> dict[str, Any]:
        with _config_lock:
            config = self.load()
            comfyui = config.setdefault("comfyui", {})
            if install_path is not None:
                comfyui["install_path"] = install_path.strip() if install_path and install_path.strip() else None
            if custom_python is not None:
                comfyui["custom_python"] = custom_python.strip() if custom_python and custom_python.strip() else None
            if host is not None:
                comfyui["host"] = host.strip() or "127.0.0.1"
            if port is not None:
                comfyui["port"] = int(port)
            if extra_args is not None:
                comfyui["extra_args"] = extra_args.strip()
            if auto_start is not None:
                comfyui["auto_start"] = bool(auto_start)
            if civitai_api_token is not None:
                token = civitai_api_token.strip()
                comfyui["civitai_api_token"] = token or None
            # An empty string clears a value; None leaves it unchanged.
            for key, value in (
                ("desktop_installation_id", desktop_installation_id),
                ("models_dir", models_dir),
                ("input_dir", input_dir),
                ("output_dir", output_dir),
            ):
                if value is not None:
                    comfyui[key] = value.strip() or None

            self.save(config)
            return comfyui

    def remote_settings(self) -> dict[str, Any]:
        return _remote_settings(self.load().get("remote"))

    def update_remote_settings(
        self,
        *,
        backend: str | None = None,
        colab_gpu: str | None = None,
        colab_idle_minutes: int | None = None,
        colab_model_cache: bool | None = None,
    ) -> dict[str, Any]:
        """Change remote GPU settings; values outside the allowed ones raise ValueError."""
        if backend is not None and backend not in REMOTE_BACKENDS:
            raise ValueError(f"Unknown backend: {backend}")
        if colab_gpu is not None and colab_gpu.upper() not in COLAB_GPUS:
            raise ValueError(f"Unknown Colab GPU: {colab_gpu}")
        if colab_idle_minutes is not None and not IDLE_MINUTES_MIN <= int(colab_idle_minutes) <= IDLE_MINUTES_MAX:
            raise ValueError(f"Idle minutes must be {IDLE_MINUTES_MIN}-{IDLE_MINUTES_MAX}.")
        if colab_model_cache is not None and not isinstance(colab_model_cache, bool):
            raise ValueError("model cache must be a boolean")
        with _config_lock:
            config = self.load()
            remote = _remote_settings(config.get("remote"))
            if backend is not None:
                remote["backend"] = backend
            if colab_gpu is not None:
                remote["colab"]["gpu"] = colab_gpu.upper()
            if colab_idle_minutes is not None:
                remote["colab"]["idle_minutes"] = int(colab_idle_minutes)
            if colab_model_cache is not None:
                remote["colab"]["model_cache"] = colab_model_cache
            config["remote"] = remote
            self.save(config)
            return remote

    def social_settings(self) -> dict[str, Any]:
        settings = self.load().get("social", {
            "telegram": {"api_id": None, "api_hash": None},
            "vk": {"client_id": None, "client_secret": None},
        })
        settings.setdefault("telegram", {"api_id": None, "api_hash": None})
        settings.setdefault("vk", {"client_id": None, "client_secret": None})
        return settings

    def update_social_settings(
        self,
        *,
        telegram_api_id: str | int | None = None,
        telegram_api_hash: str | None = None,
        vk_client_id: str | None = None,
        vk_client_secret: str | None = None,
    ) -> dict[str, Any]:
        with _config_lock:
            config = self.load()
            social = config.setdefault("social", {})
            telegram = social.setdefault("telegram", {})
            if telegram_api_id is not None:
                telegram["api_id"] = str(telegram_api_id).strip() or None
            if telegram_api_hash is not None:
                telegram["api_hash"] = telegram_api_hash.strip() or None
            vk = social.setdefault("vk", {})
            if vk_client_id is not None:
                vk["client_id"] = vk_client_id.strip() or None
            if vk_client_secret is not None:
                vk["client_secret"] = vk_client_secret.strip() or None
            self.save(config)
            return social
