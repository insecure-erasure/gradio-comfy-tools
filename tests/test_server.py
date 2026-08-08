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
