"""Tests for tools.upscale — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools.upscale import build_workflow, load_workflow, resolve_workflow, UpscaleError


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for t in ["Load Image (URL/Path)", "SeedVR2 Video Upscaler (v2.5.24)", "Random Preview Image"]:
        assert t in nodes


def test_build_workflow_filename(wf):
    built, meta = build_workflow(wf, image="ComfyUI_prev_00001_.png", seed=7)
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "temp"
    assert img["image"] == "ComfyUI_prev_00001_.png"
    assert nodes["SeedVR2 Video Upscaler (v2.5.24)"]["inputs"]["seed"] == 7
    # fixed workflow values untouched
    upscaler = nodes["SeedVR2 Video Upscaler (v2.5.24)"]["inputs"]
    assert upscaler["resolution"] == 2048
    assert upscaler["color_correction"] == "lab"
    assert meta["seed"] == 7


def test_build_workflow_url(wf):
    built, _ = build_workflow(wf, image="https://example.com/img.png", seed=-1)
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "url"
    assert img["url"] == "https://example.com/img.png"
    assert "image" not in img


def test_build_workflow_empty_image(wf):
    with pytest.raises(UpscaleError):
        build_workflow(wf, image="")


def test_build_workflow_random_seed(wf):
    import random

    random.seed(1)
    built, meta = build_workflow(wf, image="a.png", seed=-1)
    nodes = resolve_workflow(built)
    assert 0 <= nodes["SeedVR2 Video Upscaler (v2.5.24)"]["inputs"]["seed"] <= 2**64 - 1


def test_deep_copy_not_mutating_source(wf):
    built, _ = build_workflow(wf, image="a.png", seed=5)
    assert wf["424"]["inputs"]["seed"] == 0  # original untouched
    assert built["424"]["inputs"]["seed"] == 5
