"""Tests for tools.extend — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools import _common
from tools.extend import (
    BASE_PROMPT,
    DEFAULT_FEATHERING,
    MAX_FEATHERING,
    MAX_PAD,
    build_workflow,
    load_workflow,
    resolve_workflow,
    ExtendError,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for t in [
        "Load Image (URL/Path)",
        "Pad Image for Outpainting",
        "Prompt",
        "RandomNoise",
        "Flux2Scheduler",
        "Power Lora Loader (rgthree)",
        "Color Match",
        "Random Preview Image",
    ]:
        assert t in nodes


def test_build_workflow_injects_all_parameters(wf):
    built, meta = build_workflow(
        wf,
        image="ComfyUI_prev_00001_.png",
        left=10,
        top=20,
        right=30,
        bottom=40,
        feathering=25,
        prompt="add a sunset sky",
        steps=8,
        seed=5,
    )
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "temp"
    assert img["image"] == "ComfyUI_prev_00001_.png"
    assert img["url"] == ""

    pad = nodes["Pad Image for Outpainting"]["inputs"]
    assert (pad["left"], pad["top"], pad["right"], pad["bottom"]) == (10, 20, 30, 40)
    assert pad["feathering"] == 25

    prompt = nodes["Prompt"]["inputs"]
    assert prompt["string_a"] == BASE_PROMPT
    assert prompt["string_b"] == "add a sunset sky"

    assert nodes["RandomNoise"]["inputs"]["noise_seed"] == 5
    assert nodes["Flux2Scheduler"]["inputs"]["steps"] == 8

    assert meta["left"] == 10
    assert meta["right"] == 30
    assert meta["feathering"] == 25
    assert meta["prompt"] == "add a sunset sky"
    assert meta["seed"] == 5


def test_build_workflow_url_source(wf):
    built, _ = build_workflow(
        wf, image="https://example.com/img.png", left=1, prompt="x"
    )
    img = resolve_workflow(built)["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "url"
    assert img["url"] == "https://example.com/img.png"
    assert "image" not in img
    assert "Choose file to upload" not in img


def test_build_workflow_defaults(wf):
    built, meta = build_workflow(wf, image="a.png", bottom=1)
    nodes = resolve_workflow(built)
    assert nodes["Pad Image for Outpainting"]["inputs"]["feathering"] == DEFAULT_FEATHERING
    assert nodes["Flux2Scheduler"]["inputs"]["steps"] == 6  # workflow default
    assert nodes["Prompt"]["inputs"]["string_b"] == ""
    assert meta["steps"] == 0


def test_build_workflow_preserves_uint64_seed(wf):
    seed = 99910461318452
    built, meta = build_workflow(wf, image="a.png", left=1, seed=seed)
    assert resolve_workflow(built)["RandomNoise"]["inputs"]["noise_seed"] == seed
    assert meta["seed"] == seed


def test_build_workflow_loras(wf):
    built, _ = build_workflow(
        wf, image="a.png", left=1, lora_config='["user1.sft", {"name": "user2.sft", "strength": 0.5}]'
    )
    loader = resolve_workflow(built)["Power Lora Loader (rgthree)"]["inputs"]
    assert loader["lora_1"] == {"on": True, "lora": "user1.sft", "strength": 1.0}
    assert loader["lora_2"] == {"on": True, "lora": "user2.sft", "strength": 0.5}


def test_build_workflow_color_match_strength(wf):
    built, meta = build_workflow(wf, image="a.png", left=1, color_match=0.35)
    assert resolve_workflow(built)["Color Match"]["inputs"]["strength"] == 0.35
    assert meta["color_match"] == 0.35


def test_build_workflow_color_match_wiring(wf):
    built, _ = build_workflow(wf, image="a.png", left=1, color_match=0.5)
    cm_id = next(nid for nid, n in built.items()
                 if n.get("_meta", {}).get("title") == "Color Match")
    cm = built[cm_id]["inputs"]
    assert cm["image_ref"] == ["308", 0]      # original source
    assert cm["image_target"] == ["140", 0]   # VAE Decode
    assert built["338"]["inputs"]["image"] == [cm_id, 0]     # density restore
    assert built["339"]["inputs"]["image_b"] == [cm_id, 0]   # final switch


def test_build_workflow_color_match_default_keeps_workflow_value(wf):
    built, meta = build_workflow(wf, image="a.png", left=1)
    # Extend's workflow default is full match (1.0); an API client that
    # omits color_match keeps it.
    assert resolve_workflow(built)["Color Match"]["inputs"]["strength"] == 1
    assert meta["color_match"] is None


def test_build_workflow_color_match_validations(wf):
    for bad in (-0.1, 1.1, "nope", True):
        with pytest.raises(ExtendError):
            build_workflow(wf, image="a.png", left=1, color_match=bad)


def test_build_workflow_accepts_numeric_strings(wf):
    built, meta = build_workflow(
        wf, image="a.png", left="10", top="20", right="30", bottom="40", feathering="25", steps="8"
    )
    pad = resolve_workflow(built)["Pad Image for Outpainting"]["inputs"]
    assert (pad["left"], pad["top"], pad["right"], pad["bottom"]) == (10, 20, 30, 40)
    assert pad["feathering"] == 25
    assert meta["steps"] == 8


def test_build_workflow_validations(wf):
    with pytest.raises(ExtendError):
        build_workflow(wf, image="", left=1)
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png")  # all four edges zero
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png", left=1, feathering=MAX_FEATHERING + 1)
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png", left=1, steps=99)
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png", left=1, top=1.5)
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png", left=1, feathering="---1")
    with pytest.raises(ValueError):
        build_workflow(wf, image="a.png", left=1, seed=-2)


@pytest.mark.parametrize("field", ["left", "top", "right", "bottom"])
def test_padding_bounds(wf, field):
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png", **{field: -1})
    with pytest.raises(ExtendError):
        build_workflow(wf, image="a.png", **{field: MAX_PAD + 1})


def test_deep_copy_not_mutating_source(wf):
    built, _ = build_workflow(wf, image="a.png", left=10, top=20, seed=3, steps=9)
    src = resolve_workflow(wf)
    assert src["Pad Image for Outpainting"]["inputs"]["left"] == 0
    assert src["RandomNoise"]["inputs"]["noise_seed"] == 0
    assert src["Flux2Scheduler"]["inputs"]["steps"] == 6
    assert src["Color Match"]["inputs"]["strength"] == 1
    built_nodes = resolve_workflow(built)
    assert built_nodes["Pad Image for Outpainting"]["inputs"]["left"] == 10
    assert built_nodes["RandomNoise"]["inputs"]["noise_seed"] == 3
    assert built_nodes["Flux2Scheduler"]["inputs"]["steps"] == 9
