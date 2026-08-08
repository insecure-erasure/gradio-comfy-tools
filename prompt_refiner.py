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


def _refiner_ready(settings: Settings) -> str:
    """Validate + return the refiner base URL (eager — raises immediately)."""
    base = (settings.prompt_refiner_base_url or "").strip().rstrip("/")
    if not base:
        raise RefinerUnavailable(
            "Prompt refiner is not configured — set its URL in the ☰ menu"
        )
    return base


def _build_payload(system: str, prompt: str, stream: bool = False) -> dict:
    """The chat request body. Thinking is disabled via the chat template (the
    reliable way per llama.cpp docs — reasoning_effort was not)."""
    return {
        "model": DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "stream": stream,
        # Disable chain-of-thought via the chat template (the reliable way,
        # per llama.cpp docs): Qwen3-style instruct models emit a thinking
        # block by default that can land in content (or consume the whole
        # token budget leaving content empty — verified live on Qwen3.5-4B).
        # reasoning_effort=none was NOT reliable (some models still think).
        "chat_template_kwargs": {"enable_thinking": False},
    }


def _strip_think(content: str) -> str:
    """Defensive: remove a <think>...</think> block if a model still emits it."""
    if "<think>" not in content:
        return content
    end = content.find("</think>")
    return content[end + len("</think>") :].strip() if end != -1 else content.split("<think>")[0].strip()


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
    base = _refiner_ready(settings)
    system = (system_prompt or settings.prompt_refiner_system_prompt or "").strip()
    prompt = (prompt or "").strip()
    if not prompt:
        raise RefinerError("prompt must not be empty")

    payload = _build_payload(system, prompt, stream=False)
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
    refined = _strip_think((content or "").strip())
    if not refined:
        raise RefinerError("Refiner returned an empty prompt")
    return refined


def stream_refine_prompt(
    settings: Settings,
    prompt: str,
    system_prompt: str | None = None,
    timeout: float = 60.0,
):
    """Stream the refined prompt deltas (SSE from llama-server → generator).

    Returns a generator yielding each content delta as it is generated.
    The availability check is eager (raises RefinerUnavailable immediately),
    so callers can validate before starting the stream. Raises RefinerError
    for transport/API failures. When the consumer closes the generator
    (client disconnect / cancel), the underlying httpx stream is closed.
    """
    import json as _json

    base = _refiner_ready(settings)
    system = (system_prompt or settings.prompt_refiner_system_prompt or "").strip()
    prompt = (prompt or "").strip()
    if not prompt:
        raise RefinerError("prompt must not be empty")
    payload = _build_payload(system, prompt, stream=True)

    def gen():
        try:
            with httpx.Client(timeout=timeout) as client:
                with client.stream("POST", f"{base}/v1/chat/completions", json=payload) as resp:
                    if resp.status_code >= 400:
                        err = resp.read().decode("utf-8", "replace")[:200]
                        raise RefinerError(f"Refiner service error: HTTP {resp.status_code} {err}")
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[len("data:") :].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = _json.loads(data)
                        except Exception:
                            continue
                        choices = obj.get("choices") or []
                        if choices:
                            delta = choices[0].get("delta") or {}
                            content = delta.get("content")
                            if content:
                                yield {"delta": content}
                        # The final chunk carries the timings (tokens + tok/s)
                        # — forward them for the refinement stats.
                        if obj.get("timings"):
                            yield {"meta": obj["timings"]}
        except RefinerError:
            raise
        except Exception as e:
            raise RefinerError(f"Could not reach the refiner service: {e}") from e

    return gen()
