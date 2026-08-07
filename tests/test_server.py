"""Tests for server.py — FastAPI endpoints, no live ComfyUI needed.

Tool endpoints are tested with the tool functions monkeypatched (they return
a fake result URL); the settings endpoints are tested against a temp config
file; the media proxy is tested with a mocked httpx.AsyncClient.
"""

from __future__ import annotations

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
        content = b"\x89PNG"
        headers = {"content-type": "image/png"}

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, url):
            assert "filename=out.png&type=output" in url
            return FakeResp()

    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)
    resp = client.get("/media/out.png?type=output")
    assert resp.status_code == 200
    assert resp.content == b"\x89PNG"
    assert resp.headers["content-type"] == "image/png"


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
