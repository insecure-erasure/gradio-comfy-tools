"""Application configuration.

Settings load from environment variables with sensible defaults, then a
user-level JSON config file (~/.gradio-comfy-tools.json) can override them
(this is what the 🎨 settings UI writes to). All values can also be changed
at runtime via the setters, which persist to the config file.

Load order: defaults < environment < config file < runtime setters.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_BASE_URL = "http://192.168.1.8"

_CONFIG_FILE = Path.home() / ".gradio-comfy-tools.json"


class Settings:
    """Global app settings (single-user, no per-tool overrides)."""

    def __init__(self) -> None:
        self.comfyui_base_url: str = os.environ.get("COMFYUI_BASE_URL", DEFAULT_BASE_URL)
        self.comfyui_media_base_url: str = os.environ.get("COMFYUI_MEDIA_BASE_URL", "")
        self.api_key: str = os.environ.get("COMFYUI_API_KEY", "")
        self._load_from_disk()

    # ------------------------------------------------------------------ #
    # Derived
    # ------------------------------------------------------------------ #
    @property
    def media_base_url(self) -> str:
        """Public base for result URLs; falls back to the server URL."""
        return (self.comfyui_media_base_url or self.comfyui_base_url).rstrip("/")

    # ------------------------------------------------------------------ #
    # Runtime setters (persist to the user config file)
    # ------------------------------------------------------------------ #
    def set_base_url(self, url: str) -> None:
        self.comfyui_base_url = url.strip().rstrip("/")
        self.save()

    def set_media_base_url(self, url: str) -> None:
        self.comfyui_media_base_url = url.strip().rstrip("/")
        self.save()

    def set_api_key(self, key: str) -> None:
        self.api_key = key.strip()
        self.save()

    # ------------------------------------------------------------------ #
    # Persistence
    # ------------------------------------------------------------------ #
    def save(self) -> None:
        _CONFIG_FILE.write_text(
            json.dumps(
                {
                    "comfyui_base_url": self.comfyui_base_url,
                    "comfyui_media_base_url": self.comfyui_media_base_url,
                    "api_key": self.api_key,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def _load_from_disk(self) -> None:
        if not _CONFIG_FILE.exists():
            return
        try:
            data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return
        if isinstance(data, dict):
            if data.get("comfyui_base_url"):
                self.comfyui_base_url = str(data["comfyui_base_url"]).rstrip("/")
            if data.get("comfyui_media_base_url"):
                self.comfyui_media_base_url = str(data["comfyui_media_base_url"]).rstrip("/")
            if data.get("api_key"):
                self.api_key = str(data["api_key"])
