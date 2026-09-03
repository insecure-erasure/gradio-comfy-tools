"""Sync ComfyUI REST client (no Gradio dependency).

Contract validated against ComfyUI 0.29.1 — see docs/PLAN.md §A0:

    GET  /system_stats                health
    POST /upload/image                multipart upload -> temp filename
    POST /prompt                      queue workflow -> prompt_id
    GET  /history/{prompt_id}         poll until outputs appear
    GET  {media_base}/view?filename=..&type=output    public result URL

Sync by design: Gradio runs handlers in worker threads, so async buys us
nothing here (the Open WebUI reference is async only because that framework
requires it).
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any, Callable

import httpx

from config import Settings


class ComfyError(RuntimeError):
    """Semantic failure from the ComfyUI API (not an HTTP transport error)."""


# Module-level hooks fired after every successful queue_prompt:
# fn(client_id, prompt_id, workflow). server.py uses one to attach a
# per-job WebSocket listener for live progress (see /api/progress).
_prompt_hooks: list[Callable[[str, str, dict[str, Any]], None]] = []


def register_prompt_hook(fn: Callable[[str, str, dict[str, Any]], None]) -> None:
    """Register a callback invoked after each queue_prompt."""
    _prompt_hooks.append(fn)


def unregister_prompt_hook(fn: Callable[[str, str, dict[str, Any]], None]) -> None:
    """Remove a previously registered hook (used by tests)."""
    if fn in _prompt_hooks:
        _prompt_hooks.remove(fn)


class ComfyClient:
    def __init__(
        self,
        settings: Settings | None = None,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings or Settings()
        self._timeout = timeout
        # transport is injectable for tests (httpx.MockTransport)
        self._client = httpx.Client(timeout=timeout, transport=transport)

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "ComfyClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #
    def _headers(self) -> dict[str, str]:
        if self.settings.api_key:
            return {"Authorization": f"Bearer {self.settings.api_key}"}
        return {}

    def _url(self, path: str) -> str:
        return f"{self.settings.comfyui_base_url.rstrip('/')}{path}"

    def _get(self, path: str) -> Any:
        resp = self._client.get(self._url(path), headers=self._headers())
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # REST
    # ------------------------------------------------------------------ #
    def health(self) -> dict[str, Any]:
        """GET /system_stats — returns the parsed JSON."""
        return self._get("/system_stats")

    def list_loras(self) -> list[str]:
        """GET /models/loras — returns the available LoRA model filenames.

        The endpoint may return a list of strings or a list of objects with a
        ``name`` key depending on the ComfyUI version; both are handled.
        """
        data = self._get("/models/loras")
        if not isinstance(data, list):
            raise ComfyError(f"/models/loras returned an unexpected payload: {data!r}")
        names: list[str] = []
        for item in data:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict) and item.get("name"):
                names.append(str(item["name"]))
        return names

    def list_diffusion_models(self) -> list[str]:
        """GET /models/diffusion_models — available diffusion/unet filenames.

        Same string-or-object handling as list_loras.
        """
        data = self._get("/models/diffusion_models")
        if not isinstance(data, list):
            raise ComfyError(
                f"/models/diffusion_models returned an unexpected payload: {data!r}"
            )
        names: list[str] = []
        for item in data:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict) and item.get("name"):
                names.append(str(item["name"]))
        return names

    def upload_image(self, file_path: str | Path) -> str:
        """Upload a local image; returns the ComfyUI temp filename.

        POST /upload/image with type=temp (used by the image source flow:
        Edit/Upscale/Video load these via LoadImageByUrlOrPath source=temp).
        """
        path = Path(file_path)
        with path.open("rb") as f:
            resp = self._client.post(
                self._url("/upload/image"),
                headers=self._headers(),
                files={"image": (path.name, f, "image/png")},
                data={"type": "temp", "overwrite": "true"},
            )
        resp.raise_for_status()
        data = resp.json()
        name = data.get("name")
        if not name:
            raise ComfyError(f"Upload did not return a name: {data}")
        return name

    def queue_prompt(self, workflow: dict[str, Any], client_id: str | None = None, extra_data: dict[str, Any] | None = None) -> str:
        """POST /prompt — queue a workflow; returns the prompt_id.

        ``extra_data`` is passed through verbatim. The web UI uses it to
        request per-step latent previews: ``{"preview_method": "auto"}``
        makes the sampler decode its intermediate latent each step (tiny
        VAE / latent2rgb) and stream it over the WS as binary messages
        (the CLI default is NoPreviews, so without this no previews are
        generated). The flag is per-prompt and reset automatically.
        """
        # Materialize the client_id (default random) so the payload and the
        # prompt hooks use the SAME id — the WS listener must connect with it
        # to receive this prompt's per-node events.
        client_id = client_id or str(uuid.uuid4())
        payload: dict[str, Any] = {
            "prompt": workflow,
            "client_id": client_id,
        }
        if extra_data:
            payload["extra_data"] = extra_data
        resp = self._client.post(self._url("/prompt"), json=payload, headers=self._headers())
        resp.raise_for_status()
        data = resp.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"ComfyUI did not return a prompt_id: {data}")
        for hook in _prompt_hooks:
            try:
                hook(client_id, prompt_id, workflow)
            except Exception:
                pass
        return prompt_id

    def wait_for_output(
        self,
        prompt_id: str,
        timeout: float = 120.0,
        poll: float = 1.0,
        until: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        """Poll GET /history/{prompt_id} until outputs appear.

        Returns the prompt's outputs dict. ``until`` optionally narrows the
        completion condition: it is called with the outputs dict collected so
        far and polling continues while it returns False. Used by Face swap,
        whose extracted-face preview node can finish (and be recorded) long
        before the sampled result — the caller waits for the MAIN preview
        output specifically. Raises TimeoutError after ``timeout`` seconds
        without completion.
        """
        url = self._url(f"/history/{prompt_id}")
        deadline = time.monotonic() + timeout
        while True:
            resp = self._client.get(url, headers=self._headers())
            resp.raise_for_status()
            history = resp.json()
            entry = history.get(prompt_id)
            outputs = entry.get("outputs") if entry else None
            if outputs and (until is None or until(outputs)):
                return outputs
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"ComfyUI did not finish within {timeout:.0f}s (prompt {prompt_id})"
                )
            time.sleep(poll)

    def result_url(self, filename: str, type_: str = "output") -> str:
        """Public URL of a result file served from the media base URL."""
        from urllib.parse import urlencode

        return f"{self.settings.media_base_url}/view?{urlencode({'filename': filename, 'type': type_})}"

    # ------------------------------------------------------------------ #
    # Cancel
    # ------------------------------------------------------------------ #
    def interrupt(self) -> None:
        """POST /interrupt — stop the currently running prompt.

        Needs an empty body so the server sees Content-Length: 0 (ComfyUI
        rejects the request with 411 otherwise).
        """
        resp = self._client.post(self._url("/interrupt"), headers=self._headers(), content=b"")
        resp.raise_for_status()

    def cancel_prompt(self, prompt_id: str) -> None:
        """POST /queue with delete=[prompt_id] — remove a pending prompt."""
        resp = self._client.post(
            self._url("/queue"),
            json={"delete": [prompt_id]},
            headers=self._headers(),
        )
        resp.raise_for_status()
