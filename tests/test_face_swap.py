"""Tests for tools.face_swap — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools.face_swap import (
    build_workflow,
    load_workflow,
    resolve_workflow,
    FaceSwapError,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for t in [
        "Load Image (URL/Path)",   # Picture 1 — base
        "Face Reference",          # Picture 2 — face
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
