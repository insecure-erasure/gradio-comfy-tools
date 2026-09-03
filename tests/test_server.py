"""Tests for server.py — FastAPI endpoints, no live ComfyUI needed.

Tool endpoints are tested with the tool functions monkeypatched (they return
a fake result URL); the settings endpoints are tested against a temp config
file; the media proxy is tested with a mocked httpx.AsyncClient.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    """Point the Settings persistence file at a temp path."""
    import config

    cfg = tmp_path / "settings.json"
    monkeypatch.setattr(config, "_CONFIG_FILE", cfg)
    return cfg


def test_index_serves_app_html(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Comfy Tools" in resp.text
    assert "switchTab" in resp.text


def test_settings_get(client, tmp_config):
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert "comfyui_base_url" in body
    assert "media_base_url" in body
    assert "has_api_key" in body
    assert "prompt_refiner_base_url" in body
    assert "prompt_refiner_system_prompt" in body


def test_settings_post_persists_refiner(client, tmp_config):
    resp = client.post(
        "/api/settings",
        json={
            "prompt_refiner_base_url": "http://127.0.0.1:8080",
            "prompt_refiner_system_prompt": "Refine this image prompt.",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["prompt_refiner_base_url"] == "http://127.0.0.1:8080"
    assert body["prompt_refiner_system_prompt"] == "Refine this image prompt."
    from config import Settings

    s = Settings()
    assert s.prompt_refiner_base_url == "http://127.0.0.1:8080"
    assert s.prompt_refiner_system_prompt == "Refine this image prompt."


def test_settings_post_persists_refiner_model(client, tmp_config):
    resp = client.post(
        "/api/settings",
        json={
            "prompt_refiner_base_url": "http://127.0.0.1:8080",
            "prompt_refiner_model": "unsloth/Qwen3.5-4B-UD-Q8_K_XL",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["prompt_refiner_model"] == "unsloth/Qwen3.5-4B-UD-Q8_K_XL"
    from config import Settings

    s = Settings()
    assert s.prompt_refiner_model == "unsloth/Qwen3.5-4B-UD-Q8_K_XL"
    # an explicit empty model clears it back to auto
    resp = client.post("/api/settings", json={"prompt_refiner_model": ""})
    assert resp.json()["prompt_refiner_model"] == ""
    assert Settings().prompt_refiner_model == ""


def test_refiner_models_endpoint(client, tmp_config, monkeypatch):
    import prompt_refiner as pr

    client.post("/api/settings", json={"prompt_refiner_base_url": "http://127.0.0.1:8080"})

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "data": [
                    {"id": "mradermacher/Heretical-Qwen3.5-9B.i1-Q4_K_M"},
                    {"id": "unsloth/Qwen3.5-4B-UD-Q8_K_XL"},
                    {"id": "unsloth/gemma-4-E4B-it-UD-Q6_K_XL"},
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url):
            return FakeResp()

    monkeypatch.setattr(pr.httpx, "Client", FakeClient)
    resp = client.get("/api/refiner-models")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["models"]) == 3
    # default skips the 9B flagged as too heavy
    assert body["default"] == "unsloth/Qwen3.5-4B-UD-Q8_K_XL"


def test_refiner_models_endpoint_unconfigured(client, tmp_config):
    resp = client.get("/api/refiner-models")
    assert resp.status_code == 200
    assert resp.json() == {"models": [], "default": ""}


def test_refine_prompt_not_configured(client, tmp_config):
    resp = client.post("/api/refine-prompt", json={"prompt": "a cat"})
    assert resp.status_code == 400
    assert "not configured" in resp.json()["detail"]


def test_refine_prompt_calls_llama(client, tmp_config, monkeypatch):
    import prompt_refiner as pr

    client.post("/api/settings", json={"prompt_refiner_base_url": "http://127.0.0.1:8080"})

    captured = {}

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "a majestic cat in sunlight"}}]}

    class FakeClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def post(self, url, json):
            captured["url"] = url
            captured["json"] = json
            return FakeResp()

        def get(self, url):
            # /v1/models → first model for the auto pick
            return FakeModelsResp()

    class FakeModelsResp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "unsloth/Qwen3.5-4B-UD-Q8_K_XL"}]}

    monkeypatch.setattr(pr.httpx, "Client", FakeClient)
    resp = client.post(
        "/api/refine-prompt",
        json={"prompt": "a cat", "system_prompt": "Refine."},
    )
    assert resp.status_code == 200
    assert resp.json()["refined"] == "a majestic cat in sunlight"
    assert captured["url"] == "http://127.0.0.1:8080/v1/chat/completions"
    msgs = captured["json"]["messages"]
    assert msgs[0] == {"role": "system", "content": "Refine."}
    assert msgs[1] == {"role": "user", "content": "a cat"}
    # reasoning is disabled via the chat template so the refined prompt is
    # not polluted with <think> (reliable per llama.cpp docs)
    assert captured["json"]["chat_template_kwargs"] == {"enable_thinking": False}


def test_refine_prompt_stream_sse(client, tmp_config, monkeypatch):
    """stream:true returns an SSE stream of content deltas."""
    import prompt_refiner as pr

    client.post("/api/settings", json={"prompt_refiner_base_url": "http://127.0.0.1:8080"})

    captured = {}

    class FakeStreamResp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def iter_lines(self):
            return [
                'data: {"choices": [{"delta": {"content": "A fluffy"}}]}',
                'data: {"choices": [{"delta": {"content": " cat"}}]}',
                'data: {"choices": [{"delta": {}}], "timings": {"predicted_n": 17, "predicted_per_second": 11.85}}',
                "data: [DONE]",
            ]

        def read(self):
            return b""

    class FakeStreamingClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def stream(self, method, url, json):
            captured["url"] = url
            captured["json"] = json
            return FakeStreamResp()

        def get(self, url):
            return FakeModelsResp()

    class FakeModelsResp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "unsloth/Qwen3.5-4B-UD-Q8_K_XL"}]}


    monkeypatch.setattr(pr.httpx, "Client", FakeStreamingClient)
    resp = client.post("/api/refine-prompt", json={"prompt": "a cat", "stream": True})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    body = resp.text
    assert '"delta": "A fluffy"' in body
    assert '"delta": " cat"' in body
    assert '"meta": {"predicted_n": 17, "predicted_per_second": 11.85}' in body
    assert '"done": true' in body
    assert captured["json"]["stream"] is True


def test_refine_prompt_stream_sse_get(client, tmp_config, monkeypatch):
    """GET /api/refine-prompt streams deltas for the browser's EventSource."""
    import prompt_refiner as pr

    client.post("/api/settings", json={"prompt_refiner_base_url": "http://127.0.0.1:8080"})

    captured = {}

    class FakeStreamResp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def iter_lines(self):
            return [
                'data: {"choices": [{"delta": {"content": "A fluffy"}}]}',
                'data: {"choices": [{"delta": {"content": " cat"}}]}',
                'data: {"choices": [{"delta": {}}], "timings": {"predicted_n": 17, "predicted_per_second": 11.85}}',
                "data: [DONE]",
            ]

        def read(self):
            return b""

    class FakeStreamingClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def stream(self, method, url, json):
            captured["url"] = url
            captured["json"] = json
            return FakeStreamResp()

        def get(self, url):
            return FakeModelsResp()

    class FakeModelsResp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "unsloth/Qwen3.5-4B-UD-Q8_K_XL"}]}


    monkeypatch.setattr(pr.httpx, "Client", FakeStreamingClient)
    resp = client.post("/api/refine-prompt", json={"prompt": "a cat", "stream": True})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    body = resp.text
    assert '"delta": "A fluffy"' in body
    assert '"delta": " cat"' in body
    assert '"meta": {"predicted_n": 17, "predicted_per_second": 11.85}' in body
    assert '"done": true' in body
    assert captured["json"]["stream"] is True


def test_refine_prompt_strips_think_block(client, tmp_config, monkeypatch):
    """Defensive: even if the model still emits a <think>...</think> block in
    content (e.g. ignores reasoning_effort), only the text after it is kept.
    """
    import prompt_refiner as pr

    client.post("/api/settings", json={"prompt_refiner_base_url": "http://127.0.0.1:8080"})

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "choices": [{
                    "message": {
                        "content": "<think>Let me think...</think>A majestic cat in sunlight."
                    }
                }]
            }

    class FakeClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def post(self, url, json):
            return FakeResp()

        def get(self, url):
            return FakeModelsResp()

    class FakeModelsResp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "unsloth/Qwen3.5-4B-UD-Q8_K_XL"}]}

    monkeypatch.setattr(pr.httpx, "Client", FakeClient)
    resp = client.post("/api/refine-prompt", json={"prompt": "a cat"})
    assert resp.status_code == 200
    assert resp.json()["refined"] == "A majestic cat in sunlight."


def test_refine_prompt_error_becomes_400(client, tmp_config, monkeypatch):
    import prompt_refiner as pr

    client.post("/api/settings", json={"prompt_refiner_base_url": "http://127.0.0.1:8080"})

    class FakeResp:
        status_code = 500
        text = "boom"

    class FakeClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def post(self, url, json):
            return FakeResp()

        def get(self, url):
            return FakeModelsResp()

    class FakeModelsResp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "unsloth/Qwen3.5-4B-UD-Q8_K_XL"}]}

    monkeypatch.setattr(pr.httpx, "Client", FakeClient)
    resp = client.post("/api/refine-prompt", json={"prompt": "a cat"})
    assert resp.status_code == 400
    assert "HTTP 500" in resp.json()["detail"]


def test_settings_post_persists(client, tmp_config):
    resp = client.post(
        "/api/settings",
        json={"comfyui_base_url": "http://10.0.0.9:8188", "comfyui_media_base_url": "http://10.0.0.9:8188/media"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["comfyui_base_url"] == "http://10.0.0.9:8188"
    assert body["media_base_url"] == "http://10.0.0.9:8188/media"
    # persisted to disk — a fresh Settings() instance sees it
    from config import Settings

    s = Settings()
    assert s.comfyui_base_url == "http://10.0.0.9:8188"
    assert s.comfyui_media_base_url == "http://10.0.0.9:8188/media"


def test_settings_post_clears_media_override(client, tmp_config):
    client.post("/api/settings", json={"comfyui_media_base_url": "http://10.0.0.9:8188/media"})
    resp = client.post("/api/settings", json={"comfyui_media_base_url": ""})
    body = resp.json()
    # empty media base -> falls back to the server URL
    assert body["media_base_url"] == body["comfyui_base_url"]


def test_settings_post_empty_server_url_rejected(client, tmp_config):
    resp = client.post("/api/settings", json={"comfyui_base_url": "   "})
    assert resp.status_code == 400


def test_api_generate_passes_model(client, tmp_config, monkeypatch):
    received = {}

    def fake_generate(settings, **kwargs):
        received.update(kwargs)
        return "http://comfy/view?filename=out.png&type=output"

    monkeypatch.setattr(server, "generate_image", fake_generate)
    resp = client.post(
        "/api/generate",
        json={"family": "zimage", "prompt": "hi", "model": "my-model.safetensors"},
    )
    assert resp.status_code == 200
    assert received["model"] == "my-model.safetensors"
    assert resp.json()["filename"] == "out.png"
    assert resp.json()["display"].startswith("/media/")


def test_api_video_passes_diffusion(client, tmp_config, monkeypatch):
    received = {}

    def fake_video(settings, **kwargs):
        received.update(kwargs)
        return "http://comfy/view?filename=out.mp4&type=output"

    monkeypatch.setattr(server, "generate_video", fake_video)
    resp = client.post(
        "/api/video",
        json={
            "image": "a.png",
            "model_version": "wan22",
            "prompt": "x",
            "frames": 81,
            "diffusion": '{"high": "h.safetensors", "low": "l.safetensors"}',
        },
    )
    assert resp.status_code == 200
    assert received["diffusion"] == '{"high": "h.safetensors", "low": "l.safetensors"}'
    assert resp.json()["filename"] == "out.mp4"


def test_api_upscale_seed(client, tmp_config, monkeypatch):
    received = {}

    def fake_upscale(settings, **kwargs):
        received.update(kwargs)
        return "http://comfy/view?filename=up.png&type=output"

    monkeypatch.setattr(server, "upscale_image", fake_upscale)
    resp = client.post("/api/upscale", json={"image": "a.png", "seed": 42})
    assert resp.status_code == 200
    assert received["seed"] == 42


def test_api_face_swap_passes_params(client, tmp_config, monkeypatch):
    received = {}

    def fake_face_swap(settings, **kwargs):
        received.update(kwargs)
        return "http://comfy/view?filename=swapped.png&type=temp", None

    monkeypatch.setattr(server, "face_swap_image", fake_face_swap)
    resp = client.post(
        "/api/face-swap",
        json={"image": "base.png", "face": "face.png", "prompt": "add a subtle smile", "steps": 8, "cfg": 2.0, "seed": 7},
    )
    assert resp.status_code == 200
    assert received["image"] == "base.png"
    assert received["face"] == "face.png"
    assert received["prompt"] == "add a subtle smile"
    assert received["steps"] == 8
    assert received["cfg"] == 2.0
    assert received["seed"] == 7
    assert resp.json()["filename"] == "swapped.png"
    assert resp.json()["type"] == "temp"
    assert "face_preview" not in resp.json()  # no face preview -> no extra key


def test_api_face_swap_tool_error_becomes_400(client, tmp_config, monkeypatch):
    def boom(settings, **kwargs):
        raise ValueError("image (base) must not be empty")

    monkeypatch.setattr(server, "face_swap_image", boom)
    resp = client.post("/api/face-swap", json={"image": "", "face": "f.png"})
    assert resp.status_code == 400


def test_api_face_swap_includes_face_preview(client, tmp_config, monkeypatch):
    def fake_face_swap(settings, **kwargs):
        return (
            "http://comfy/view?filename=swapped.png&type=temp",
            "http://comfy/view?filename=face_crop.png&type=temp",
        )

    monkeypatch.setattr(server, "face_swap_image", fake_face_swap)
    resp = client.post("/api/face-swap", json={"image": "base.png", "face": "face.png"})
    assert resp.status_code == 200
    j = resp.json()
    assert j["filename"] == "swapped.png"  # main result unchanged
    fp = j["face_preview"]
    assert fp["filename"] == "face_crop.png"
    assert fp["type"] == "temp"
    assert fp["display"].startswith("/media/face_crop.png")


def test_index_serves_face_swap_tab(client, tmp_config):
    resp = client.get("/")
    assert resp.status_code == 200
    html = resp.text
    # The new tab partial + its disabled prompt + script are all wired up.
    assert 'id="tab-face_swap"' in html
    assert 'id="faceSwapSourceUrl"' in html
    assert 'id="faceSwapFaceUrl"' in html
    assert 'id="promptInputFaceSwap"' in html
    assert 'data-tab="face_swap"' in html
    assert 'face_swap.js' in html


def test_api_loras(client, tmp_config, monkeypatch):
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_loras(self):
            return ["foo.safetensors", "bar.safetensors"]

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    resp = client.get("/api/loras")
    assert resp.status_code == 200
    assert resp.json() == {"loras": ["foo.safetensors", "bar.safetensors"]}


def test_api_loras_error(client, tmp_config, monkeypatch):
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_loras(self):
            raise RuntimeError("boom")

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    resp = client.get("/api/loras")
    assert resp.status_code == 502


def test_api_diffusion_models(client, tmp_config, monkeypatch):
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_diffusion_models(self):
            return ["a.safetensors", "b.safetensors"]

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    resp = client.get("/api/diffusion-models")
    assert resp.status_code == 200
    assert resp.json() == {"models": ["a.safetensors", "b.safetensors"]}


def test_api_generate_tool_error_becomes_400(client, tmp_config, monkeypatch):
    def boom(settings, **kwargs):
        raise ValueError("prompt must not be empty")

    monkeypatch.setattr(server, "generate_image", boom)
    resp = client.post("/api/generate", json={"prompt": ""})
    assert resp.status_code == 400
    assert "prompt" in resp.json()["detail"]


def test_media_proxy(client, tmp_config, monkeypatch):
    import httpx

    class FakeResp:
        status_code = 200
        headers = {"content-type": "image/png"}

        async def aiter_bytes(self):
            yield b"\x89PNG"

    class FakeRequest:
        def __init__(self, url, headers):
            self.url = url
            self.headers = headers or {}

    class FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        def build_request(self, method, url, headers=None):
            assert method == "GET"
            assert "filename=out.png&type=output" in url
            return FakeRequest(url, headers)

        async def send(self, request, stream=False):
            # the endpoint streams: the client must stay alive until the
            # body is consumed (StreamingResponse + BackgroundTask aclose)
            assert stream is True
            return FakeResp()

        async def aclose(self):
            pass

    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)
    resp = client.get("/media/out.png?type=output")
    assert resp.status_code == 200
    assert resp.content == b"\x89PNG"
    assert resp.headers["content-type"] == "image/png"


def test_media_proxy_range_206(client, tmp_config, monkeypatch):
    """The proxy must pass Range through and stream with a 206 so <video>
    elements can seek/buffer progressively (videos were unplayable with the
    old full-buffer proxy)."""
    import httpx

    class FakeResp:
        status_code = 206
        headers = {
            "content-type": "video/mp4",
            "content-range": "bytes 0-1023/4096",
            "accept-ranges": "bytes",
        }

        async def aiter_bytes(self):
            yield b"\x00" * 16

    class FakeRequest:
        def __init__(self, url, headers):
            self.url = url
            self.headers = headers or {}

    class FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        def build_request(self, method, url, headers=None):
            assert headers == {"Range": "bytes=0-1023"}  # the range is passed through
            return FakeRequest(url, headers)

        async def send(self, request, stream=False):
            return FakeResp()

        async def aclose(self):
            pass

    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)
    resp = client.get("/media/out.mp4?type=output", headers={"Range": "bytes=0-1023"})
    assert resp.status_code == 206
    assert resp.headers["content-range"] == "bytes 0-1023/4096"
    assert resp.headers["accept-ranges"] == "bytes"


# --------------------------------------------------------------------------- #
# POST /api/check-image
# --------------------------------------------------------------------------- #
def _mock_streaming_client(monkeypatch, status_code=200, content_type="image/png", head=b"\x89PNG\r\n\x1a\n", seen_urls=None):
    """Fake httpx.AsyncClient with a stream() that yields one chunk."""
    class FakeStreamResp:
        def __init__(self, status_code, content_type):
            self.status_code = status_code
            self.headers = {"content-type": content_type}

        async def aiter_bytes(self, n):
            yield head[:n]

    class FakeStreamCtx:
        def __init__(self, url):
            self.url = url

        async def __aenter__(self):
            if seen_urls is not None:
                seen_urls.append(self.url)
            return FakeStreamResp(status_code, content_type)

        async def __aexit__(self, *a):
            return None

    class FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        def stream(self, method, url):
            return FakeStreamCtx(url)

    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)
    return FakeAsyncClient


def test_check_image_temp_filename_uses_media_view(client, tmp_config, monkeypatch):
    # a bare filename -> the tools' filename-vs-URL convention: source=temp,
    # so the check builds {media_base}/view?filename=..&type=temp
    seen = []
    _mock_streaming_client(monkeypatch, seen_urls=seen)
    resp = client.post("/api/check-image", json={"url": "ComfyUI_temp_abc.png"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "content_type": "image/png"}
    assert len(seen) == 1
    assert "filename=ComfyUI_temp_abc.png&type=temp" in seen[0]


def test_check_image_external_url_checked_directly(client, tmp_config, monkeypatch):
    seen = []
    _mock_streaming_client(monkeypatch, seen_urls=seen)
    resp = client.post("/api/check-image", json={"url": "http://example.com/pic.jpg"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "content_type": "image/png"}
    assert seen == ["http://example.com/pic.jpg"]


def test_check_image_not_an_image(client, tmp_config, monkeypatch):
    _mock_streaming_client(monkeypatch, content_type="text/html", head=b"<!doctype html>")
    resp = client.post("/api/check-image", json={"url": "http://example.com/"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "Not an image" in body["error"]


def test_check_image_http_error(client, tmp_config, monkeypatch):
    _mock_streaming_client(monkeypatch, status_code=404, content_type="")
    resp = client.post("/api/check-image", json={"url": "http://example.com/nope.png"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "404" in body["error"]


def test_check_image_magic_bytes_fallback(client, tmp_config, monkeypatch):
    # some servers serve images as application/octet-stream; the magic-byte
    # sniff must still accept a real PNG header
    _mock_streaming_client(monkeypatch, content_type="application/octet-stream", head=b"\x89PNG\r\n\x1a\n")
    resp = client.post("/api/check-image", json={"url": "http://example.com/pic"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "content_type": "application/octet-stream"}


def test_check_image_empty_url(client, tmp_config, monkeypatch):
    resp = client.post("/api/check-image", json={"url": "  "})
    assert resp.status_code == 200
    assert resp.json() == {"ok": False, "error": "No URL provided"}


# --------------------------------------------------------------------------- #
# GET /api/progress
# --------------------------------------------------------------------------- #
def test_api_progress_empty(client, tmp_config):
    resp = client.get("/api/progress")
    assert resp.status_code == 200
    assert resp.json() == {"active": None}


def test_api_progress_active_then_done(client, tmp_config, monkeypatch):
    # do not open a real WebSocket — the listener is a no-op
    monkeypatch.setattr(server, "_listen_job_ws", lambda *a, **k: None)
    server._start_job_listener(
        "cid",
        "pid123",
        {"1": {"class_type": "LoadImageByUrlOrPath", "_meta": {"title": "Load Image"}}},
    )
    try:
        resp = client.get("/api/progress").json()
        assert resp["active"] is not None
        assert resp["active"]["prompt_id"] == "pid123"
        assert resp["active"]["stage"] == "queued"
        # simulate the WS listener updating state
        with server._jobs_lock:
            server._jobs["pid123"].update(stage="running", node="1", node_title="Load Image", value=2, max=8)
        resp = client.get("/api/progress").json()
        assert resp["active"]["stage"] == "running"
        assert resp["active"]["node_title"] == "Load Image"
        assert resp["active"]["value"] == 2
        assert resp["active"]["max"] == 8
        # job finishes -> no longer active
        server._mark_job_result("pid123", "http://x/view?filename=a.png&type=output")
        resp = client.get("/api/progress").json()
        assert resp["active"] is None
        with server._jobs_lock:
            assert server._jobs["pid123"]["url"] == "http://x/view?filename=a.png&type=output"
    finally:
        with server._jobs_lock:
            server._jobs.clear()


# --------------------------------------------------------------------------- #
# /ws/progress (live progress push)
# --------------------------------------------------------------------------- #
def test_ws_progress_snapshot_and_broadcast(client, tmp_config):
    """/ws/progress pushes a snapshot on connect and every job update as it
    happens — the frontend no longer needs to poll /api/progress.
    """
    # No job -> the connect snapshot is idle.
    with client.websocket_connect("/ws/progress") as ws:
        assert ws.receive_json() == {"active": None}

    # A running job: the snapshot carries it, updates are pushed live.
    with client.websocket_connect("/ws/progress") as ws:
        assert ws.receive_json() == {"active": None}
        with server._jobs_lock:
            server._jobs["pidws"] = {
                "prompt_id": "pidws", "started": 1.0, "stage": "queued",
                "node": None, "node_title": None, "value": None, "max": None,
                "done": False, "error": None,
            }
        server._broadcast_progress(server._jobs["pidws"])
        msg = ws.receive_json()
        assert msg == {"active": {
            "prompt_id": "pidws", "stage": "queued", "node": None,
            "node_title": None, "value": None, "max": None,
        }}
        # stage update pushed
        with server._jobs_lock:
            server._jobs["pidws"].update(
                stage="running", node="5", node_title="KSampler", value=3, max=9
            )
        server._broadcast_progress(server._jobs["pidws"])
        msg = ws.receive_json()
        assert msg["active"]["stage"] == "running"
        assert msg["active"]["node_title"] == "KSampler"
        assert msg["active"]["value"] == 3
        assert msg["active"]["max"] == 9
        # per-step preview pushed as a data URL
        with server._jobs_lock:
            server._jobs["pidws"]["preview"] = b"\xff\xd8\xfffake"
        server._broadcast_progress(server._jobs["pidws"])
        msg = ws.receive_json()
        assert msg["active"]["preview"].startswith("data:image/jpeg;base64,")
        # completion pushed as active:null
        server._mark_job_result("pidws", "http://x/view?filename=a.png&type=output")
        assert ws.receive_json() == {"active": None}
        with server._jobs_lock:
            server._jobs.clear()


def test_ws_progress_job_listener_broadcasts(client, tmp_config, monkeypatch):
    """The per-job ComfyUI listener thread pushes its updates (and the job
    start pushes the "queued" state) — simulated through the real mutators.
    """
    monkeypatch.setattr(server, "_listen_job_ws", lambda *a, **k: None)
    with client.websocket_connect("/ws/progress") as ws:
        assert ws.receive_json() == {"active": None}
        # starting a job broadcasts "queued"
        server._start_job_listener(
            "cid", "pidq", {"1": {"class_type": "X", "_meta": {"title": "T"}}}
        )
        msg = ws.receive_json()
        assert msg["active"]["prompt_id"] == "pidq"
        assert msg["active"]["stage"] == "queued"
        # a binary preview frame broadcast via the handler
        import struct
        meta = json.dumps({"node_id": "1", "prompt_id": "pidq"})
        frame = struct.pack(">I", 4) + struct.pack(">I", len(meta)) + meta.encode() + b"jpeg"
        server._handle_ws_binary(frame, "pidq")
        msg = ws.receive_json()
        assert msg["active"]["preview"].startswith("data:image/jpeg;base64,")
        # done via the marker -> active:null
        server._mark_job_result("pidq", "http://x/view?filename=a.png&type=output")
        assert ws.receive_json() == {"active": None}
        with server._jobs_lock:
            server._jobs.clear()


def test_listener_records_output_without_deadlock(client, tmp_config, monkeypatch):
    """Regression: the WS listener records the result URL when the job
    completes, WITHOUT deadlocking. Recording while holding _jobs_lock (a
    non-reentrant threading.Lock) blocked the listener forever and froze
    every API endpoint the moment a job finished. The listener runs in its
    own thread here; if it deadlocks again the record never lands and the
    assertion fails after a short timeout instead of hanging the suite.
    """
    import time as _time
    import websockets.sync.client as wsclient
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"6": {"images": [{"filename": "out.mp4", "type": "output"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://x/view?filename={filename}&type={type_}"

    class FakeWS:
        """Yields one execution_success for our prompt, then ends."""
        def __init__(self, prompt_id):
            self.prompt_id = prompt_id
            self.sent = []

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def send(self, msg):
            self.sent.append(msg)

        def __iter__(self):
            yield json.dumps({"type": "execution_success", "data": {"prompt_id": self.prompt_id}})

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    monkeypatch.setattr(wsclient, "connect", lambda *a, **k: FakeWS("pidl"))
    server._start_job_listener("cid", "pidl", {"1": {"class_type": "X", "_meta": {"title": "T"}}})
    try:
        # The record lands on a separate thread — poll briefly for it.
        deadline = _time.monotonic() + 5
        url = None
        while _time.monotonic() < deadline:
            with server._jobs_lock:
                url = server._jobs.get("pidl", {}).get("url")
            if url:
                break
            _time.sleep(0.05)
        with server._jobs_lock:
            job = server._jobs["pidl"]
            assert job["done"] is True
        assert url == "http://x/view?filename=out.mp4&type=output"
    finally:
        # If the (old, buggy) code deadlocked, the listener thread holds
        # _jobs_lock forever — never block the suite on it.
        if not server._jobs_lock.acquire(timeout=1):
            server._jobs.clear()
        else:
            server._jobs.clear()
            server._jobs_lock.release()


def test_record_job_output_sets_url(client, tmp_config, monkeypatch):
    """The WS listener records the result URL on completion (server-side
    recovery path): even when the HTTP handler's wait_for_output timed out
    (long videos) or the client is gone, /api/last-result resolves the job.
    The server keeps no on-disk user state.
    """
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"6": {"images": [{"filename": "out.mp4", "type": "output"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://x/view?filename={filename}&type={type_}"

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    server._start_job_listener(
        "cid", "pidrec", {"1": {"class_type": "X", "_meta": {"title": "T"}}}
    )
    try:
        # Simulate the listener thread completing the job: done + URL recorded.
        server._record_job_output("pidrec", tool="video", prompt="a cat")
        with server._jobs_lock:
            job = server._jobs["pidrec"]
            assert job["done"] is True
            assert job["url"] == "http://x/view?filename=out.mp4&type=output"
        # The recovery endpoint can now resolve it.
        assert client.get("/api/last-result").json() == {
            "url": "http://x/view?filename=out.mp4&type=output"
        }
        # And /api/progress is idle (job settled).
        assert client.get("/api/progress").json() == {"active": None}
        # No on-disk history — the server keeps no user state (galleries
        # live in localStorage on the client).
        assert client.get("/api/history").status_code == 404
    finally:
        with server._jobs_lock:
            server._jobs.clear()


def test_api_generate_records_history(client, tmp_config, monkeypatch):
    """A completed /api/generate resolves its result in memory (no on-disk
    history — the server keeps no user state)."""
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def queue_prompt(self, wf, client_id=None, extra_data=None):
            from comfy_client import _prompt_hooks

            for hook in _prompt_hooks:
                hook("cid", "pidgen", wf)
            return "pidgen"

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"6": {"images": [{"filename": "out.png", "type": "output"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://x/view?filename={filename}&type={type_}"

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)

    def fake_generate(settings, **kwargs):
        from comfy_client import ComfyClient as C

        with C(settings=settings) as c:
            c.queue_prompt({}, extra_data={"preview_method": "auto"})
            c.wait_for_output("pidgen")
            return c.result_url("out.png")

    monkeypatch.setattr(server, "generate_image", fake_generate)
    # Keep the WS listener from opening a real socket, but still register
    # the job (the prompt hook calls _start_job_listener, which creates the
    # in-memory job that _mark_latest_done attaches the URL to).
    real_start = server._start_job_listener
    monkeypatch.setattr(server, "_listen_job_ws", lambda *a, **k: None)
    monkeypatch.setattr(
        server, "_start_job_listener",
        lambda cid, pid, wf: real_start(cid, pid, wf),
    )
    resp = client.post("/api/generate", json={"prompt": "a sunset"})
    assert resp.status_code == 200
    # No on-disk history — the server keeps no user state (galleries live
    # in localStorage on the client).
    assert client.get("/api/history").status_code == 404


def test_preview_binary_with_metadata_stored_and_served(client, tmp_config, monkeypatch):
    """A PREVIEW_IMAGE_WITH_METADATA (event 4) frame stores the JPEG in the
    job, /api/progress serves it as a data URL while active, and the preview
    is dropped once the job finishes (no stale frames, no memory retained).
    """
    import struct

    monkeypatch.setattr(server, "_listen_job_ws", lambda *a, **k: None)
    server._start_job_listener("cid", "pid123", {"1": {"class_type": "X", "_meta": {"title": "T"}}})
    try:
        meta = json.dumps({"node_id": "429", "prompt_id": "pid123", "image_type": "jpeg"})
        jpg = b"\xff\xd8\xff\xe0fakejpeg"
        frame = struct.pack(">I", 4) + struct.pack(">I", len(meta)) + meta.encode() + jpg
        server._handle_ws_binary(frame, "pid123")

        with server._jobs_lock:
            assert server._jobs["pid123"]["preview"] == jpg

        resp = client.get("/api/progress").json()
        assert resp["active"]["preview"].startswith("data:image/jpeg;base64,")
        import base64
        assert base64.b64decode(resp["active"]["preview"].split(",", 1)[1]) == jpg

        # job finishes -> preview dropped, no longer active
        server._mark_job_result("pid123", "http://x/view?filename=a.png&type=output")
        resp = client.get("/api/progress").json()
        assert resp["active"] is None
        with server._jobs_lock:
            assert "preview" not in server._jobs["pid123"]
    finally:
        with server._jobs_lock:
            server._jobs.clear()


def test_preview_binary_legacy_and_malformed(client, tmp_config, monkeypatch):
    """Legacy PREVIEW_IMAGE (event 1) also stores the image; malformed frames
    are ignored without killing the listener.
    """
    import struct

    monkeypatch.setattr(server, "_listen_job_ws", lambda *a, **k: None)
    server._start_job_listener("cid", "pid123", {})
    try:
        jpg = b"fakejpegbytes"
        legacy = struct.pack(">I", 1) + struct.pack(">I", 1) + jpg  # type_num=1 (jpeg)
        server._handle_ws_binary(legacy, "pid123")
        with server._jobs_lock:
            assert server._jobs["pid123"]["preview"] == jpg

        # unknown event / garbage -> ignored, job intact
        server._handle_ws_binary(b"\x00\x00\x00\x63whatever", "pid123")
        server._handle_ws_binary(b"\x00\x00", "pid123")
        with server._jobs_lock:
            assert server._jobs["pid123"]["preview"] == jpg
    finally:
        with server._jobs_lock:
            server._jobs.clear()


def test_api_cancel(client, tmp_config, monkeypatch):
    import comfy_client as cc
    calls = []

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def interrupt(self):
            calls.append("interrupt")

        def cancel_prompt(self, pid):
            calls.append(("delete", pid))

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    # register a job so there is something to cancel
    monkeypatch.setattr(server, "_listen_job_ws", lambda *a, **k: None)
    server._start_job_listener("cid", "pid123", {"1": {"class_type": "X"}})
    try:
        resp = client.post("/api/cancel")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["prompt_id"] == "pid123"
        assert body["interrupt"] is True
        assert body["delete"] is True
        assert "interrupt" in calls and ("delete", "pid123") in calls
        # the job is now done -> /api/progress idle
        with server._jobs_lock:
            assert server._jobs["pid123"]["done"] is True
        assert client.get("/api/progress").json() == {"active": None}
    finally:
        with server._jobs_lock:
            server._jobs.clear()


def test_api_cancel_no_job(client, tmp_config, monkeypatch):
    import comfy_client as cc

    calls = []

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def interrupt(self):
            calls.append("interrupt")

        def cancel_prompt(self, pid):
            calls.append(("delete", pid))

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    resp = client.post("/api/cancel")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["prompt_id"] is None
    assert "interrupt" in calls  # interrupt is always attempted
    assert not [c for c in calls if isinstance(c, tuple)]


def test_media_exists_head_ok(client, tmp_config, monkeypatch):
    """HEAD upstream succeeds → exists True (cheapest path, no body)."""
    import httpx

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def head(self, url, headers=None):
            assert "filename=out.png&type=output" in url
            r = type("R", (), {})()
            r.status_code = 200
            return r

        def get(self, url, headers=None):
            raise AssertionError("get should not be called when HEAD works")

    monkeypatch.setattr(httpx, "Client", FakeClient)
    resp = client.get("/api/media-exists?filename=out.png&type=output")
    assert resp.status_code == 200
    assert resp.json() == {"exists": True, "status": 200}


def test_media_exists_head_rejected_get_206(client, tmp_config, monkeypatch):
    """Server rejects HEAD → falls back to GET+Range (206 → exists)."""
    import httpx

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def head(self, url, headers=None):
            r = type("R", (), {})()
            r.status_code = 405
            return r

        def get(self, url, headers=None):
            assert headers == {"Range": "bytes=0-0"}
            r = type("R", (), {})()
            r.status_code = 206
            return r

    monkeypatch.setattr(httpx, "Client", FakeClient)
    resp = client.get("/api/media-exists?filename=out.png&type=output")
    assert resp.status_code == 200
    assert resp.json() == {"exists": True, "status": 206}


def test_media_exists_404(client, tmp_config, monkeypatch):
    """Upstream 404 → exists False (file pruned)."""
    import httpx

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def head(self, url, headers=None):
            r = type("R", (), {})()
            r.status_code = 404
            return r

        def get(self, url, headers=None):
            r = type("R", (), {})()
            r.status_code = 404
            return r

    monkeypatch.setattr(httpx, "Client", FakeClient)
    resp = client.get("/api/media-exists?filename=gone.png&type=output")
    assert resp.status_code == 200
    assert resp.json() == {"exists": False, "status": 404}


def test_media_exists_transport_error(client, tmp_config, monkeypatch):
    """Transport failure → exists False with error (not an HTTP 500)."""
    import httpx

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def head(self, url, headers=None):
            raise httpx.ConnectError("down")

        def get(self, url, headers=None):
            raise httpx.ConnectError("down")

    monkeypatch.setattr(httpx, "Client", FakeClient)
    resp = client.get("/api/media-exists?filename=out.png&type=output")
    assert resp.status_code == 200
    assert resp.json()["exists"] is False
    assert resp.json()["error"] == "transport"


def test_listener_captures_face_preview_on_executed(client, tmp_config, monkeypatch):
    """The WS listener captures the extracted-face preview the moment the
    workflow's face-preview output node executes (BEFORE the sampling), so
    the UI can show the extraction early — the payload then carries it."""
    import time as _time
    import websockets.sync.client as wsclient
    import comfy_client as cc

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"199": {"images": [{"filename": "swapped.png", "type": "temp"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://x/view?filename={filename}&type={type_}"

    msgs = [
        {
            "type": "executed",
            "data": {
                "node": "302",
                "output": {"images": [{"filename": "ComfyUI_temp_face.png", "subfolder": "", "type": "temp"}]},
                "prompt_id": "pidex",
            },
        },
        {"type": "execution_success", "data": {"prompt_id": "pidex"}},
    ]

    class FakeWS:
        def __init__(self):
            self.sent = []

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def send(self, msg):
            self.sent.append(msg)

        def __iter__(self):
            for m in msgs:
                yield json.dumps(m)

    monkeypatch.setattr(cc, "ComfyClient", FakeClient)
    monkeypatch.setattr(wsclient, "connect", lambda *a, **k: FakeWS())
    wf = {
        "199": {"class_type": "RandomPreviewImage", "_meta": {"title": "Random Preview Image"}},
        "302": {"class_type": "RandomPreviewImage", "_meta": {"title": "Random Preview Image (face)"}},
    }
    server._start_job_listener("cid", "pidex", wf)
    try:
        deadline = _time.monotonic() + 5
        fp = None
        while _time.monotonic() < deadline:
            with server._jobs_lock:
                fp = server._jobs.get("pidex", {}).get("face_preview")
            if fp:
                break
            _time.sleep(0.05)
        assert fp == "/media/ComfyUI_temp_face.png?type=temp"
        with server._jobs_lock:
            assert server._jobs["pidex"]["done"] is True
    finally:
        if not server._jobs_lock.acquire(timeout=1):
            server._jobs.clear()
        else:
            server._jobs.clear()
            server._jobs_lock.release()


def test_progress_payload_includes_face_preview():
    """A running Face swap job whose face-preview node executed carries the
    extracted-face /media path in the progress payload (painted early)."""
    job = {
        "prompt_id": "p1",
        "started": 1,
        "stage": "running",
        "node": "302",
        "node_title": "Random Preview Image (face)",
        "done": False,
        "face_preview": "/media/ComfyUI_temp_face.png?type=temp",
    }
    active = server._progress_payload(job)["active"]
    assert active["face_preview"] == "/media/ComfyUI_temp_face.png?type=temp"
    # absent when the face node has not executed yet
    job2 = dict(job, face_preview=None)
    assert "face_preview" not in server._progress_payload(job2)["active"]


def test_api_generate_timeout_is_408_recoverable(client, tmp_config, monkeypatch):
    """A backend wait timeout (the job may still be running on ComfyUI) is
    a 408 — the frontend treats it as recoverable, unlike terminal 400s."""
    def boom(settings, **kwargs):
        raise TimeoutError("ComfyUI did not finish within 120s")

    monkeypatch.setattr(server, "generate_image", boom)
    resp = client.post("/api/generate", json={"prompt": "a cat"})
    assert resp.status_code == 408
    assert "did not finish" in resp.json()["detail"]


def test_api_generate_oom_is_400_terminal(client, tmp_config, monkeypatch):
    """A real ComfyUI execution failure (e.g. CUDA OOM) surfaces as a 400
    with the ComfyUI message — terminal, nothing will finish."""
    from comfy_client import ComfyError

    def boom(settings, **kwargs):
        raise ComfyError("CUDA out of memory")

    monkeypatch.setattr(server, "generate_image", boom)
    resp = client.post("/api/generate", json={"prompt": "a cat"})
    assert resp.status_code == 400
    assert "CUDA out of memory" in resp.json()["detail"]


def test_progress_payload_carries_job_error():
    """A job that ended in a ComfyUI execution error carries the message in
    the payload, so the UI can stop waiting immediately."""
    job_err = {"prompt_id": "p1", "started": 1, "done": True, "error": "CUDA out of memory"}
    assert server._progress_payload(job_err) == {"active": None, "error": "CUDA out of memory"}
    job_ok = {"prompt_id": "p2", "started": 1, "done": True}
    assert server._progress_payload(job_ok) == {"active": None}
    assert server._progress_payload(None) == {"active": None}
