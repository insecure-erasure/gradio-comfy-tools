"""Tests for tools.adjust — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools.adjust import (
    MAX_FACTOR,
    NEUTRAL_FACTOR,
    AdjustError,
    build_workflow,
    load_workflow,
    resolve_workflow,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for title in ["Load Image (URL/Path)", "Adjust Color", "Random Preview Image"]:
        assert title in nodes


def test_workflow_contains_no_model_or_sampler(wf):
    class_types = {node.get("class_type") for node in wf.values()}
    assert class_types == {
        "LoadImageByUrlOrPath",
        "LayerColor: Brightness & Contrast",
        "RandomPreviewImage",
    }


def test_build_workflow_injects_all_factors(wf):
    built, meta = build_workflow(
        wf,
        image="ComfyUI_prev_00001_.png",
        brightness=1.1,
        contrast=0.9,
        saturation=1.25,
    )
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "temp"
    assert img["image"] == "ComfyUI_prev_00001_.png"

    adjust = nodes["Adjust Color"]["inputs"]
    assert adjust["brightness"] == 1.1
    assert adjust["contrast"] == 0.9
    assert adjust["saturation"] == 1.25
    assert meta == {
        "image": "ComfyUI_prev_00001_.png",
        "brightness": 1.1,
        "contrast": 0.9,
        "saturation": 1.25,
    }


def test_build_workflow_url_source(wf):
    built, _ = build_workflow(
        wf, image="https://example.com/img.png", saturation=1.5
    )
    img = resolve_workflow(built)["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "url"
    assert img["url"] == "https://example.com/img.png"
    assert "image" not in img
    assert "Choose file to upload" not in img


def test_build_workflow_defaults_are_neutral(wf):
    built, meta = build_workflow(wf, image="a.png")
    adjust = resolve_workflow(built)["Adjust Color"]["inputs"]
    assert adjust["brightness"] == NEUTRAL_FACTOR
    assert adjust["contrast"] == NEUTRAL_FACTOR
    assert adjust["saturation"] == NEUTRAL_FACTOR
    assert meta["brightness"] == NEUTRAL_FACTOR


def test_build_workflow_accepts_numeric_strings(wf):
    built, meta = build_workflow(
        wf, image="a.png", brightness="1.2", contrast="0.8", saturation="2"
    )
    adjust = resolve_workflow(built)["Adjust Color"]["inputs"]
    assert adjust["brightness"] == 1.2
    assert adjust["contrast"] == 0.8
    assert adjust["saturation"] == 2.0
    assert meta["saturation"] == 2.0


def test_build_workflow_validations(wf):
    with pytest.raises(AdjustError):
        build_workflow(wf, image="", saturation=1.1)
    with pytest.raises(AdjustError):
        build_workflow(wf, image="a.png", brightness=-0.1)
    with pytest.raises(AdjustError):
        build_workflow(wf, image="a.png", contrast=MAX_FACTOR + 0.1)
    with pytest.raises(AdjustError):
        build_workflow(wf, image="a.png", saturation="nope")
    with pytest.raises(AdjustError):
        build_workflow(wf, image="a.png", brightness=True)
    with pytest.raises(AdjustError):
        build_workflow(wf, image="a.png", contrast=float("nan"))
    with pytest.raises(AdjustError):
        build_workflow(wf, image="a.png", saturation=float("inf"))


def test_deep_copy_not_mutating_source(wf):
    built, _ = build_workflow(wf, image="a.png", brightness=1.3, saturation=0.5)
    src = resolve_workflow(wf)
    assert src["Adjust Color"]["inputs"]["brightness"] == NEUTRAL_FACTOR
    assert src["Adjust Color"]["inputs"]["saturation"] == NEUTRAL_FACTOR
    built_nodes = resolve_workflow(built)
    assert built_nodes["Adjust Color"]["inputs"]["brightness"] == 1.3
    assert built_nodes["Adjust Color"]["inputs"]["saturation"] == 0.5
