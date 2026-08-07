"""Tests for comfy_client and tools._common — no live server needed
(httpx.MockTransport).
"""

from __future__ import annotations

import json

import httpx
import pytest

from comfy_client import (
    ComfyClient,
    ComfyError,
    register_prompt_hook,
    unregister_prompt_hook,
)
from config import Settings
from tools import _common


def make_client(handler) -> ComfyClient:
    """Client with an injected MockTransport and a fixed config."""
    settings = Settings()
    settings.comfyui_base_url = "http://test:8188"
    settings.comfyui_media_base_url = ""
    settings.api_key = ""
    transport = httpx.MockTransport(handler)
    return ComfyClient(settings=settings, transport=transport)


# --------------------------------------------------------------------------- #
# comfy_client
# --------------------------------------------------------------------------- #
def test_health():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/system_stats"
        return httpx.Response(
            200,
            json={"system": {"comfyui_version": "0.29.1"}},
        )

    client = make_client(handler)
    assert client.health()["system"]["comfyui_version"] == "0.29.1"


def test_list_loras_strings():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/models/loras"
        return httpx.Response(200, json=["foo.safetensors", "bar.safetensors"])

    client = make_client(handler)
    assert client.list_loras() == ["foo.safetensors", "bar.safetensors"]


def test_list_loras_objects():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/models/loras"
        return httpx.Response(
            200, json=[{"name": "foo.safetensors"}, {"name": "bar.safetensors"}]
        )

    client = make_client(handler)
    assert client.list_loras() == ["foo.safetensors", "bar.safetensors"]


def test_list_loras_unexpected_payload():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    client = make_client(handler)
    with pytest.raises(ComfyError):
        client.list_loras()


def test_list_diffusion_models_strings():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/models/diffusion_models"
        return httpx.Response(200, json=["a.safetensors", "b.safetensors"])

    client = make_client(handler)
    assert client.list_diffusion_models() == ["a.safetensors", "b.safetensors"]


def test_list_diffusion_models_unexpected():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"nope": 1})

    client = make_client(handler)
    with pytest.raises(ComfyError):
        client.list_diffusion_models()


def test_upload_image_returns_name():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/upload/image"
        assert request.headers.get("content-type", "").startswith("multipart/form-data")
        return httpx.Response(200, json={"name": "ComfyUI_temp_test_00001_.png"})

    client = make_client(handler)
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "img.png"
        p.write_bytes(b"fake-png")
        assert client.upload_image(p) == "ComfyUI_temp_test_00001_.png"


def test_upload_image_missing_name_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    client = make_client(handler)
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "img.png"
        p.write_bytes(b"fake-png")
        with pytest.raises(ComfyError):
            client.upload_image(p)


def test_queue_prompt_returns_prompt_id():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/prompt"
        body = json.loads(request.content)
        assert "prompt" in body and "client_id" in body
        return httpx.Response(200, json={"prompt_id": "abc123"})

    client = make_client(handler)
    assert client.queue_prompt({"1": {"class_type": "SaveImage", "inputs": {}}}) == "abc123"


def test_queue_prompt_missing_prompt_id_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": "nope"})

    client = make_client(handler)
    with pytest.raises(ComfyError):
        client.queue_prompt({})


def test_prompt_hook_fired_after_queue():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"prompt_id": "abc123"})

    calls = []

    def hook(client_id, prompt_id, workflow):
        calls.append((client_id, prompt_id, workflow))

    register_prompt_hook(hook)
    try:
        client = make_client(handler)
        wf = {"1": {"class_type": "SaveImage", "inputs": {}}}
        pid = client.queue_prompt(wf, "cid-xyz")
        assert pid == "abc123"
        assert calls == [("cid-xyz", "abc123", wf)]
    finally:
        unregister_prompt_hook(hook)


def test_prompt_hook_receives_real_client_id_when_auto_generated():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"prompt_id": "abc123"})

    sent = {}

    def hook(client_id, prompt_id, workflow):
        sent["client_id"] = client_id

    register_prompt_hook(hook)
    try:
        client = make_client(handler)
        client.queue_prompt({"1": {}})  # no explicit client_id
        assert sent.get("client_id")  # a uuid was generated and used
    finally:
        unregister_prompt_hook(hook)


def test_prompt_hook_error_does_not_break_queue():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"prompt_id": "abc123"})

    def hook(client_id, prompt_id, workflow):
        raise RuntimeError("hook boom")

    register_prompt_hook(hook)
    try:
        client = make_client(handler)
        assert client.queue_prompt({"1": {}}, "cid") == "abc123"
    finally:
        unregister_prompt_hook(hook)


def test_wait_for_output_polls_until_done():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/history/abc123"
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(200, json={})
        return httpx.Response(
            200,
            json={
                "abc123": {
                    "outputs": {
                        "2": {
                            "images": [
                                {"filename": "out.png", "subfolder": "", "type": "output"}
                            ]
                        }
                    }
                }
            },
        )

    client = make_client(handler)
    outputs = client.wait_for_output("abc123", timeout=10, poll=0.01)
    assert outputs["2"]["images"][0]["filename"] == "out.png"
    assert calls["n"] == 3


def test_wait_for_output_times_out():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    client = make_client(handler)
    with pytest.raises(TimeoutError):
        client.wait_for_output("abc123", timeout=0.05, poll=0.01)


def test_http_error_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = make_client(handler)
    with pytest.raises(httpx.HTTPStatusError):
        client.health()


def test_result_url():
    client = make_client(lambda req: httpx.Response(200, json={}))
    url = client.result_url("img.png", "output")
    assert url == "http://test:8188/view?filename=img.png&type=output"


# --------------------------------------------------------------------------- #
# tools._common
# --------------------------------------------------------------------------- #
def test_resolve_node_by_title():
    wf = {
        "1": {"class_type": "SaveImage", "_meta": {"title": "Save"}},
        "2": {"class_type": "VAEDecode", "_meta": {"title": "Decode"}},
    }
    node_id, node = _common.resolve_node(wf, "Decode")
    assert node_id == "2"
    assert node["class_type"] == "VAEDecode"


def test_resolve_node_missing_raises():
    wf = {"1": {"class_type": "SaveImage", "_meta": {"title": "Save"}}}
    with pytest.raises(_common.WorkflowError):
        _common.resolve_node(wf, "Nope")


def test_resolve_node_ambiguous_raises():
    wf = {
        "1": {"class_type": "A", "_meta": {"title": "Same"}},
        "2": {"class_type": "B", "_meta": {"title": "Same"}},
    }
    with pytest.raises(_common.WorkflowError):
        _common.resolve_node(wf, "Same")


def test_configure_image_node_url():
    inputs = {"source": "temp", "url": "", "image": "prev.png", "Choose file to upload": None}
    _common.configure_image_node(inputs, "https://example.com/img.png")
    assert inputs["source"] == "url"
    assert inputs["url"] == "https://example.com/img.png"
    assert "image" not in inputs
    assert "Choose file to upload" not in inputs


def test_configure_image_node_filename():
    inputs = {"source": "url", "url": "", "Choose file to upload": None}
    _common.configure_image_node(inputs, "ComfyUI_prev_00001_.png")
    assert inputs["source"] == "temp"
    assert inputs["image"] == "ComfyUI_prev_00001_.png"
    assert inputs["url"] == ""


def test_normalize_source():
    assert _common.normalize_source("ComfyUI_prev_00001_.png") == ("ComfyUI_prev_00001_.png", "filename")
    assert _common.normalize_source("https://example.com/img.png") == ("https://example.com/img.png", "url")


def test_snap_frames_matches_reference():
    # Values computed from _snap_to_valid_frames in generate_video/tool.py
    assert _common.snap_frames(80) == 81
    assert _common.snap_frames(81) == 81
    assert _common.snap_frames(82) == 81
    assert _common.snap_frames(83) == 81
    assert _common.snap_frames(100) == 101
    assert _common.snap_frames(159) == 157
    assert _common.snap_frames(161) == 161
    assert _common.snap_frames(200) == 161


def test_resolve_seed():
    import random

    random.seed(0)
    s = _common.resolve_seed(-1)
    assert 0 <= s <= _common.COMFY_SEED_MAX
    assert _common.resolve_seed(42) == 42
    assert _common.resolve_seed(10**30) == _common.COMFY_SEED_MAX


def test_parse_lora_config():
    assert _common.parse_lora_config("[]") == []
    assert _common.parse_lora_config('["lora1.sft"]') == ["lora1.sft"]
    assert _common.parse_lora_config(
        '[{"name": "lora2.sft", "strength": 0.5}]'
    ) == [{"name": "lora2.sft", "strength": 0.5}]
    with pytest.raises(ValueError):
        _common.parse_lora_config("not json")
    with pytest.raises(ValueError):
        _common.parse_lora_config('"just-a-string"')
    with pytest.raises(ValueError):
        _common.parse_lora_config("[42]")


def test_apply_loras_grows_and_fills():
    inputs = {
        "lora_1": {"on": False, "lora": "", "strength": 1},
        "lora_2": {"on": False, "lora": "", "strength": 1},
    }
    _common.apply_loras(inputs, ["a.sft", {"name": "b.sft", "strength": 0.5}, "c.sft"])
    assert inputs["lora_1"] == {"on": True, "lora": "a.sft", "strength": 1}
    assert inputs["lora_2"] == {"on": True, "lora": "b.sft", "strength": 0.5}
    # grew a third slot
    assert inputs["lora_3"] == {"on": True, "lora": "c.sft", "strength": 1}


def test_apply_loras_disables_empty_or_zero():
    inputs = {"lora_1": {"on": False, "lora": "", "strength": 1}}
    _common.apply_loras(inputs, [{"name": "", "strength": 1.0}])
    assert inputs["lora_1"]["on"] is False
    _common.apply_loras(inputs, [{"name": "x.sft", "strength": 0}])
    assert inputs["lora_1"]["on"] is False
