"""Prompt refiner client — llama-server (OpenAI-compatible API).

llama-server exposes `POST /v1/chat/completions` with the standard OpenAI
chat schema: ``{"model": ..., "messages": [...], "temperature": ...}``.
This module calls it with the configured base URL and the user's system
prompt, and returns the assistant's message (the refined prompt).

The service is optional: an empty base URL (not configured in the ☰ menu)
raises ``RefinerUnavailable`` so the UI can toast that it is disabled.
"""

from __future__ import annotations

import httpx

from config import Settings


class RefinerError(RuntimeError):
    """User-facing failure from the refiner service."""


class RefinerUnavailable(RefinerError):
    """The refiner base URL is not configured (🪄 disabled)."""


DEFAULT_MODEL = "instruct"  # llama-server ignores the model name


def refine_prompt(
    settings: Settings,
    prompt: str,
    system_prompt: str | None = None,
    timeout: float = 60.0,
) -> str:
    """Refine a user prompt via llama-server's OpenAI-compatible API.

    Returns the refined prompt text (trimmed). Raises RefinerUnavailable
    when no base URL is configured, or RefinerError on transport/API
    failures (HTTP status, empty response, malformed payload).
    """
    base = (settings.prompt_refiner_base_url or "").strip().rstrip("/")
    if not base:
        raise RefinerUnavailable(
            "Prompt refiner is not configured — set its URL in the ☰ menu"
        )
    system = (system_prompt or settings.prompt_refiner_system_prompt or "").strip()
    prompt = (prompt or "").strip()
    if not prompt:
        raise RefinerError("prompt must not be empty")

    payload = {
        "model": DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        # Disable chain-of-thought: Qwen3-style instruct models emit a
        # <think> block by default that lands in message.content (verified
        # live). reasoning_effort=none turns it off so the assistant returns
        # just the refined prompt (llama.cpp OpenAI-compatible docs).
        "reasoning_effort": "none",
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{base}/v1/chat/completions", json=payload)
    except Exception as e:
        raise RefinerError(f"Could not reach the refiner service: {e}") from e
    if resp.status_code >= 400:
        raise RefinerError(f"Refiner service error: HTTP {resp.status_code} {resp.text[:200]}")
    try:
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as e:
        raise RefinerError(f"Refiner returned an unexpected payload: {resp.text[:200]}") from e
    refined = (content or "").strip()
    # Defensive: strip a <think>...</think> block if the model still emits
    # reasoning (e.g. a model that ignores reasoning_effort), keeping only
    # the actual refined prompt.
    if "<think>" in refined:
        end = refined.find("</think>")
        refined = refined[end + len("</think>") :].strip() if end != -1 else refined.split("<think>")[0].strip()
    if not refined:
        raise RefinerError("Refiner returned an empty prompt")
    return refined
