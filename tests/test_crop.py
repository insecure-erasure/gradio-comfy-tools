"""Tests for tools.crop — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools.crop import (
    MAX_COORD,
    MAX_SIZE,
    CropError,
    build_workflow,
    load_workflow,
    resolve_workflow,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for title in ["Load Image (URL/Path)", "Crop Image", "Random Preview Image"]:
        assert title in nodes


def test_workflow_contains_no_model_or_sampler(wf):
    # Crop is a deterministic pixel operation: it must never load a model or
    # queue a sampling job.
    class_types = {node.get("class_type") for node in wf.values()}
    assert class_types == {"LoadImageByUrlOrPath", "ImageCrop", "RandomPreviewImage"}


def test_build_workflow_injects_all_parameters(wf):
    built, meta = build_workflow(
        wf,
        image="ComfyUI_prev_00001_.png",
        x=12,
        y=34,
        width=640,
        height=480,
    )
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "temp"
    assert img["image"] == "ComfyUI_prev_00001_.png"
    assert img["url"] == ""

    crop = nodes["Crop Image"]["inputs"]
    assert (crop["x"], crop["y"], crop["width"], crop["height"]) == (12, 34, 640, 480)
    assert meta == {
        "image": "ComfyUI_prev_00001_.png",
        "x": 12,
        "y": 34,
        "width": 640,
        "height": 480,
    }


def test_build_workflow_url_source(wf):
    built, _ = build_workflow(
        wf, image="https://example.com/img.png", width=10, height=10
    )
    img = resolve_workflow(built)["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "url"
    assert img["url"] == "https://example.com/img.png"
    assert "image" not in img
    assert "Choose file to upload" not in img


def test_build_workflow_defaults_position_to_zero(wf):
    built, meta = build_workflow(wf, image="a.png", width=100, height=50)
    crop = resolve_workflow(built)["Crop Image"]["inputs"]
    assert crop["x"] == 0
    assert crop["y"] == 0
    assert meta["x"] == 0
    assert meta["y"] == 0


def test_build_workflow_accepts_numeric_strings(wf):
    built, meta = build_workflow(
        wf, image="a.png", x="10", y="20", width="300", height="200"
    )
    crop = resolve_workflow(built)["Crop Image"]["inputs"]
    assert (crop["x"], crop["y"], crop["width"], crop["height"]) == (10, 20, 300, 200)
    assert meta["width"] == 300


def test_build_workflow_validations(wf):
    with pytest.raises(CropError):
        build_workflow(wf, image="", width=10, height=10)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=0, height=10)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height=0)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10.5, height=10)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height="---1")
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=True, height=10)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height=10, x="-1")
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height=10, y="-1")


def test_build_workflow_bounds(wf):
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=MAX_SIZE + 1, height=10)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height=MAX_SIZE + 1)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height=10, x=MAX_COORD + 1)
    with pytest.raises(CropError):
        build_workflow(wf, image="a.png", width=10, height=10, y=MAX_COORD + 1)


def test_deep_copy_not_mutating_source(wf):
    built, _ = build_workflow(wf, image="a.png", x=5, y=6, width=70, height=80)
    src = resolve_workflow(wf)
    assert src["Crop Image"]["inputs"]["x"] == 0
    assert src["Crop Image"]["inputs"]["width"] == 512
    assert src["Load Image (URL/Path)"]["inputs"]["image"] == ""

    built_nodes = resolve_workflow(built)
    assert built_nodes["Crop Image"]["inputs"]["x"] == 5
    assert built_nodes["Crop Image"]["inputs"]["width"] == 70
