"""Tests for the fullscreen gallery's ℹ️ metadata endpoint.

ComfyUI embeds the API prompt in PNG text chunks; GET /api/image-info reads
it so the gallery can report the parameters that ACTUALLY produced an image
(even for entries restored from localStorage in a later session).
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(server.app)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))


def _make_png(width: int, height: int, texts: dict[str, str]) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    chunks = [_png_chunk(b"IHDR", ihdr)]
    for key, value in texts.items():
        chunks.append(_png_chunk(b"tEXt", key.encode("latin-1") + b"\x00"
                                 + value.encode("utf-8")))
    chunks.append(_png_chunk(b"IEND", b""))
    return server._PNG_SIGNATURE + b"".join(chunks)


def _prompt() -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "zImageTurbo.safetensors"}},
        "2": {
            "class_type": "Power Lora Loader (rgthree)",
            "inputs": {
                "lora_1": {"on": True, "lora": "style.safetensors", "strength": 0.75},
                "lora_2": {"on": False, "lora": "disabled.safetensors", "strength": 1},
            },
        },
        "3": {"class_type": "easy int", "inputs": {"value": 9}},
        "4": {"class_type": "BasicScheduler",
              "inputs": {"steps": ["3", 0], "scheduler": "simple"}},
        "5": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "6": {"class_type": "ImpactSwitch",
              "inputs": {"select": 1, "input1": ["4", 0], "input2": ["7", 0]},
              "_meta": {"title": "Switch (SIGMAS)"}},
        "7": {"class_type": "Flux2Scheduler", "inputs": {"steps": 6}},
    }


def test_extracts_technical_parameters_from_the_api_prompt():
    meta = server._image_prompt_metadata(_prompt())
    assert meta["steps"] == [9]
    assert meta["samplers"] == ["euler"]
    assert meta["schedulers"] == ["simple"]
    assert meta["models"] == ["zImageTurbo.safetensors"]
    assert meta["loras"] == [{"name": "style.safetensors", "weight": 0.75}]


def test_follows_the_sigmas_switch_to_the_active_scheduler():
    """With select=2 the unused BasicScheduler must not leak its scheduler."""
    prompt = _prompt()
    prompt["6"]["inputs"]["select"] = 2
    meta = server._image_prompt_metadata(prompt)
    assert meta["steps"] == [6]
    assert meta["schedulers"] == ["Flux2Scheduler"]


def test_reads_png_dimensions_and_prompt_chunk():
    png = _make_png(832, 1248, {"prompt": json.dumps(_prompt())})
    width, height, chunks = server._png_image_info(png)
    assert (width, height) == (832, 1248)
    assert json.loads(chunks["prompt"])["1"]["class_type"] == "UNETLoader"


def test_image_info_endpoint_returns_metadata(client, monkeypatch):
    png = _make_png(832, 1248, {"prompt": json.dumps(_prompt())})
    calls = []

    class FakeSettings:
        media_base_url = "http://comfy.test"

    class FakeResponse:
        status_code = 200
        content = png

        def raise_for_status(self):
            pass

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url):
            calls.append(url)
            return FakeResponse()

    monkeypatch.setattr(server, "_settings", lambda: FakeSettings())
    monkeypatch.setattr(server.httpx, "Client", FakeClient)

    resp = client.get("/api/image-info?filename=ComfyUI_00001_.png&type=output")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["has_metadata"] is True
    assert (body["width"], body["height"]) == (832, 1248)
    assert body["steps"] == [9]
    assert body["samplers"] == ["euler"]
    assert body["schedulers"] == ["simple"]
    assert body["models"] == ["zImageTurbo.safetensors"]
    assert body["loras"] == [{"name": "style.safetensors", "weight": 0.75}]
    assert "filename=ComfyUI_00001_.png" in calls[0]


def test_image_info_without_embedded_prompt_still_returns_resolution(client, monkeypatch):
    png = _make_png(512, 512, {})

    class FakeSettings:
        media_base_url = "http://comfy.test"

    class FakeResponse:
        status_code = 200
        content = png

        def raise_for_status(self):
            pass

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url):
            return FakeResponse()

    monkeypatch.setattr(server, "_settings", lambda: FakeSettings())
    monkeypatch.setattr(server.httpx, "Client", FakeClient)
    monkeypatch.setattr(server, "_history_prompt_for_filename", lambda filename: None)

    body = client.get("/api/image-info?filename=plain.png").json()
    assert body["has_metadata"] is False
    assert body["metadata_source"] is None
    assert (body["width"], body["height"]) == (512, 512)
    assert body["steps"] == []
    assert body["loras"] == []


def test_image_info_falls_back_to_comfyui_history(client, monkeypatch):
    """A custom save node without PNG metadata: use the queued API prompt."""
    png = _make_png(512, 512, {})

    class FakeSettings:
        media_base_url = "http://comfy.test"

    class FakeResponse:
        status_code = 200
        content = png

        def raise_for_status(self):
            pass

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url):
            return FakeResponse()

    monkeypatch.setattr(server, "_settings", lambda: FakeSettings())
    monkeypatch.setattr(server.httpx, "Client", FakeClient)
    monkeypatch.setattr(
        server, "_history_prompt_for_filename",
        lambda filename: _prompt() if filename == "plain.png" else None,
    )

    body = client.get("/api/image-info?filename=plain.png").json()
    assert body["has_metadata"] is True
    assert body["metadata_source"] == "history"
    assert body["steps"] == [9]
    assert body["models"] == ["zImageTurbo.safetensors"]
    assert body["loras"] == [{"name": "style.safetensors", "weight": 0.75}]


def test_history_lookup_matches_the_output_filename(monkeypatch):
    import comfy_client

    history = {
        "prompt-1": {
            "prompt": [0, "prompt-1", _prompt(), {}, ["9"]],
            "outputs": {"9": {"images": [{"filename": "other.png", "type": "output"}]}},
        },
        "prompt-2": {
            "prompt": [0, "prompt-2", _prompt(), {}, ["9"]],
            "outputs": {"9": {"images": [{"filename": "target.png", "type": "output"}]}},
        },
    }

    class FakeHistoryClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def history(self, max_items=200):
            assert max_items == 200
            return history

    monkeypatch.setattr(comfy_client, "ComfyClient", FakeHistoryClient)
    prompt = server._history_prompt_for_filename("target.png")
    assert prompt["1"]["class_type"] == "UNETLoader"
    assert server._history_prompt_for_filename("missing.png") is None
