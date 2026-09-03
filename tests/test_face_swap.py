"""Tests for tools.face_swap — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools import _common
from tools.face_swap import (
    _HEAD_SWAP_LORA_NAME,
    build_workflow,
    face_swap_image,
    load_workflow,
    resolve_workflow,
    FaceSwapError,
)
from config import Settings


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for t in [
        "Load Image (URL/Path)",   # Picture 1 — base
        "Face Reference",          # Picture 2 — face
        "Load LoRA",               # dedicated head-swap LoRA
        "Prompt",                  # optional extra prompt (appended by concat)
        "Concat Prompt (Positive)",  # built-in head_swap text + extra prompt
        "Flux2Scheduler",
        "CFG Guider",
        "RandomNoise",
        "Random Preview Image",
    ]:
        assert t in nodes


def test_build_workflow_external_urls(wf):
    built, meta = build_workflow(
        wf,
        image="https://example.com/base.png",
        face="https://example.com/face.png",
        steps=8,
        cfg=2.0,
        seed=5,
    )
    nodes = resolve_workflow(built)
    base = nodes["Load Image (URL/Path)"]["inputs"]
    face = nodes["Face Reference"]["inputs"]
    assert base["source"] == "url"
    assert base["url"] == "https://example.com/base.png"
    assert "image" not in base
    assert face["source"] == "url"
    assert face["url"] == "https://example.com/face.png"
    assert "image" not in face
    assert "Choose file to upload" not in base and "Choose file to upload" not in face
    assert nodes["Flux2Scheduler"]["inputs"]["steps"] == 8
    assert nodes["CFG Guider"]["inputs"]["cfg"] == 2.0
    assert nodes["RandomNoise"]["inputs"]["noise_seed"] == 5
    assert meta["seed"] == 5
    assert meta["image"] == "https://example.com/base.png"
    assert meta["face"] == "https://example.com/face.png"


def test_build_workflow_temp_filenames(wf):
    built, _ = build_workflow(
        wf,
        image="ComfyUI_prev_00001_.png",
        face="ComfyUI_temp_00002_.png",
    )
    nodes = resolve_workflow(built)
    assert nodes["Load Image (URL/Path)"]["inputs"]["source"] == "temp"
    assert nodes["Load Image (URL/Path)"]["inputs"]["image"] == "ComfyUI_prev_00001_.png"
    assert nodes["Face Reference"]["inputs"]["source"] == "temp"
    assert nodes["Face Reference"]["inputs"]["image"] == "ComfyUI_temp_00002_.png"


def test_build_workflow_defaults_kept(wf):
    # steps=0 / cfg=None → keep the workflow defaults (6 / 1)
    built, meta = build_workflow(wf, image="a.png", face="b.png", steps=0, cfg=None)
    nodes = resolve_workflow(built)
    assert nodes["Flux2Scheduler"]["inputs"]["steps"] == 6
    assert nodes["CFG Guider"]["inputs"]["cfg"] == 1.0
    assert meta["steps"] == 0
    assert meta["cfg"] is None


def test_build_workflow_explicit_cfg_zero_applied(wf):
    # cfg=0 is a VALID explicit value (no guidance) — not "keep default".
    built, meta = build_workflow(wf, image="a.png", face="b.png", cfg=0.0)
    assert resolve_workflow(built)["CFG Guider"]["inputs"]["cfg"] == 0.0
    assert meta["cfg"] == 0.0


def test_build_workflow_cfg_decimals_applied(wf):
    # 0.1-stepped control — fractional values pass through unchanged.
    built, _ = build_workflow(wf, image="a.png", face="b.png", cfg=1.3)
    assert resolve_workflow(built)["CFG Guider"]["inputs"]["cfg"] == 1.3


def test_build_workflow_validations(wf):
    with pytest.raises(FaceSwapError):
        build_workflow(wf, image="", face="b.png")
    with pytest.raises(FaceSwapError):
        build_workflow(wf, image="a.png", face="")
    with pytest.raises(FaceSwapError):
        build_workflow(wf, image="a.png", face="b.png", steps=99)
    with pytest.raises(FaceSwapError):
        build_workflow(wf, image="a.png", face="b.png", cfg=9.0)
    with pytest.raises(FaceSwapError):
        build_workflow(wf, image="a.png", face="b.png", cfg=-0.1)  # below the 0 floor


def test_deep_copy_not_mutating_source(wf):
    build_workflow(
        wf,
        image="https://example.com/a.png",
        face="https://example.com/b.png",
        steps=12,
        cfg=3.0,
        seed=42,
    )
    src = resolve_workflow(wf)
    # Originals untouched: both image nodes ship EMPTY (no leftover sample
    # references — the tool injects the sources at runtime), and the
    # sampling defaults / exported seed are intact.
    assert src["Load Image (URL/Path)"]["inputs"]["source"] == "temp"
    assert src["Load Image (URL/Path)"]["inputs"]["image"] == ""
    assert src["Face Reference"]["inputs"]["image"] == ""
    assert src["Face Reference"]["inputs"]["url"] == ""
    assert src["Flux2Scheduler"]["inputs"]["steps"] == 6
    assert src["CFG Guider"]["inputs"]["cfg"] == 1.0
    assert src["RandomNoise"]["inputs"]["noise_seed"] != 42


# --------------------------------------------------------------------------- #
# Dedicated head-swap LoRA — OS-independent name resolution + injection
# --------------------------------------------------------------------------- #
def test_workflow_default_lora_is_os_neutral(wf):
    # The JSON default is the bare basename — never an OS-specific subfolder
    # path (ComfyUI lists flux2/... on Linux but flux2\\... on Windows).
    src = resolve_workflow(wf)["Load LoRA"]["inputs"]
    assert src["lora_name"] == _HEAD_SWAP_LORA_NAME
    assert "/" not in src["lora_name"] and "\\" not in src["lora_name"]


def test_build_workflow_injects_head_swap_lora_name(wf):
    # face_swap_image resolves the installed name from the server (OS-native
    # separators) and passes it here — it must land verbatim in the strict
    # LoraLoaderModelOnly combo.
    windows_name = "flux2\\bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors"
    built, meta = build_workflow(wf, image="a.png", face="b.png", lora_name=windows_name)
    lora = resolve_workflow(built)["Load LoRA"]["inputs"]
    assert lora["lora_name"] == windows_name
    assert lora["strength_model"] == 1  # fixed workflow values untouched
    assert meta["lora_name"] == windows_name
    # deep-copy safety: the source workflow default is not mutated
    assert resolve_workflow(wf)["Load LoRA"]["inputs"]["lora_name"] == _HEAD_SWAP_LORA_NAME


def test_build_workflow_keeps_default_lora_when_omitted(wf):
    built, meta = build_workflow(wf, image="a.png", face="b.png")
    assert resolve_workflow(built)["Load LoRA"]["inputs"]["lora_name"] == _HEAD_SWAP_LORA_NAME
    assert meta["lora_name"] is None


# --------------------------------------------------------------------------- #
# Optional extra prompt — appended after the built-in head_swap text
# --------------------------------------------------------------------------- #
def test_build_workflow_injects_extra_prompt(wf):
    built, meta = build_workflow(
        wf, image="a.png", face="b.png", prompt="add a subtle smile, keep teeth natural"
    )
    nodes = resolve_workflow(built)
    # The extra prompt lands in the PrimitiveStringMultiline that feeds the
    # concat node's string_b (appended AFTER the built-in head_swap text).
    assert nodes["Prompt"]["inputs"]["value"] == "add a subtle smile, keep teeth natural"
    assert meta["prompt"] == "add a subtle smile, keep teeth natural"
    # The concat wiring is untouched: string_a still carries the built-in
    # head_swap instructions and string_b still links to the Prompt node.
    concat = nodes["Concat Prompt (Positive)"]["inputs"]
    assert concat["string_a"].startswith("head_swap:")
    prompt_node_id = next(
        nid for nid, n in wf.items() if n.get("_meta", {}).get("title") == "Prompt"
    )
    assert concat["string_b"] == [prompt_node_id, 0]
    # Deep-copy safety: the source workflow keeps its empty default.
    assert resolve_workflow(wf)["Prompt"]["inputs"]["value"] == ""


def test_build_workflow_empty_prompt_keeps_default(wf):
    built, _ = build_workflow(wf, image="a.png", face="b.png", prompt="")
    assert resolve_workflow(built)["Prompt"]["inputs"]["value"] == ""
    # The positive CLIPTextEncode reads the concat node (a link, not a
    # literal), so with an empty extra prompt the final text is the
    # built-in head_swap text — the concat wiring is preserved by the tool.
    _, clip = _common.resolve_node(built, "CLIP Text Encode (Positive Prompt)")
    assert clip["inputs"]["text"] == [
        next(nid for nid, n in built.items() if n.get("_meta", {}).get("title") == "Concat Prompt (Positive)"),
        0,
    ]


def test_face_swap_image_prompt_reaches_workflow(monkeypatch):
    import tools.face_swap as fs

    captured = {}

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_loras(self):
            return ["flux2\\bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors"]

        def queue_prompt(self, wf, client_id=None, extra_data=None):
            captured["wf"] = wf
            return "pid-1"

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"199": {"images": [{"filename": "x.png", "type": "output"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://comfy/view?filename={filename}&type={type_}"

    monkeypatch.setattr(fs, "ComfyClient", FakeClient)
    fs.face_swap_image(Settings(), image="a.png", face="b.png", prompt="soften the jaw")
    prompt_node = resolve_workflow(captured["wf"])["Prompt"]["inputs"]
    assert prompt_node["value"] == "soften the jaw"


def test_build_workflow_rejects_blank_lora_name(wf):
    with pytest.raises(FaceSwapError):
        build_workflow(wf, image="a.png", face="b.png", lora_name="   ")


# --------------------------------------------------------------------------- #
# face_swap_image — resolves the installed LoRA name against the server
# --------------------------------------------------------------------------- #
def test_face_swap_image_resolves_and_injects_installed_lora(monkeypatch):
    import tools.face_swap as fs

    captured = {}

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_loras(self):
            # Windows-style listing (backslash subfolder separators).
            return [
                "flux2\\Flux2-Klein-Image-RestoreV1.safetensors",
                "flux2\\bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors",
            ]

        def queue_prompt(self, wf, client_id=None, extra_data=None):
            captured["wf"] = wf
            return "pid-1"

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"199": {"images": [{"filename": "swapped.png", "subfolder": "", "type": "output"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://comfy/view?filename={filename}&type={type_}"

    monkeypatch.setattr(fs, "ComfyClient", FakeClient)
    url = fs.face_swap_image(Settings(), image="a.png", face="b.png", steps=8)

    assert url == "http://comfy/view?filename=swapped.png&type=output"
    wf = captured["wf"]
    lora = resolve_workflow(wf)["Load LoRA"]["inputs"]
    # The EXACT server-listed name (backslashes on Windows) is injected, not
    # the forward-slash basename or the JSON default.
    assert lora["lora_name"] == "flux2\\bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors"
    assert resolve_workflow(wf)["Flux2Scheduler"]["inputs"]["steps"] == 8


def test_face_swap_image_linux_listing_injects_forward_slash_name(monkeypatch):
    import tools.face_swap as fs

    captured = {}

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_loras(self):
            return ["flux2/bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors"]

        def queue_prompt(self, wf, client_id=None, extra_data=None):
            captured["wf"] = wf
            return "pid-1"

        def wait_for_output(self, prompt_id, timeout=None, poll=None):
            return {"199": {"images": [{"filename": "x.png", "type": "output"}]}}

        def result_url(self, filename, type_="output"):
            return f"http://comfy/view?filename={filename}&type={type_}"

    monkeypatch.setattr(fs, "ComfyClient", FakeClient)
    fs.face_swap_image(Settings(), image="a.png", face="b.png")
    lora = resolve_workflow(captured["wf"])["Load LoRA"]["inputs"]
    assert lora["lora_name"] == "flux2/bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors"


def test_face_swap_image_missing_lora_raises_clear_error(monkeypatch):
    import tools.face_swap as fs

    class FakeClient:
        def __init__(self, settings=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def list_loras(self):
            return ["flux2\\some-other-lora.safetensors"]

        def queue_prompt(self, wf, client_id=None, extra_data=None):
            raise AssertionError("must not queue when the head-swap LoRA is missing")

    monkeypatch.setattr(fs, "ComfyClient", FakeClient)
    with pytest.raises(FaceSwapError, match="not installed"):
        fs.face_swap_image(Settings(), image="a.png", face="b.png")
