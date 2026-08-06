"""Tests for tools.video — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools.video import (
    MODEL_VERSIONS,
    VIDEO_MODEL_CONFIGS,
    build_workflow,
    load_workflow,
    resolve_workflow,
    VideoError,
)


@pytest.fixture
def wf21():
    return load_workflow("wan21")


@pytest.fixture
def wf22():
    return load_workflow("wan22")


def test_model_versions():
    assert MODEL_VERSIONS == ["wan21", "wan22"]
    assert "high" in VIDEO_MODEL_CONFIGS["wan22"]
    assert "high" not in VIDEO_MODEL_CONFIGS["wan21"]


def test_resolve_workflow_wan21(wf21):
    nodes = resolve_workflow(wf21, is_dual=False)
    for t in ["Positive Prompt", "Negative Prompt", "Load Image (URL/Path)", "WanImageToVideo", "EasySeed", "unet main", "ksampler main"]:
        assert t in nodes


def test_resolve_workflow_wan22(wf22):
    nodes = resolve_workflow(wf22, is_dual=True)
    for t in ["unet high", "unet low", "ksampler high", "ksampler low", "lora high", "lora low"]:
        assert t in nodes


def test_build_workflow_wan21(wf21):
    built, meta = build_workflow(
        wf21, "wan21", image="ComfyUI_prev_00001_.png", prompt="the apple rotates", frames=81, steps=4, seed=9
    )
    nodes = resolve_workflow(built, is_dual=False)
    assert nodes["Positive Prompt"]["inputs"]["text"] == "the apple rotates"
    assert nodes["Load Image (URL/Path)"]["inputs"]["image"] == "ComfyUI_prev_00001_.png"
    assert nodes["WanImageToVideo"]["inputs"]["length"] == 81
    assert nodes["EasySeed"]["inputs"]["seed"] == 9
    k = nodes["ksampler main"]["inputs"]
    assert k["steps"] == 4
    assert k["sampler_name"] == "euler"
    assert k["scheduler"] == "simple"
    assert nodes["unet main"]["inputs"]["unet_name"] == "Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v-nvfp4.safetensors"
    assert meta["frames"] == 81


def test_build_workflow_wan21_negative(wf21):
    built, _ = build_workflow(wf21, "wan21", image="a.png", prompt="x", negative_prompt="blurry")
    nodes = resolve_workflow(built, is_dual=False)
    assert nodes["Negative Prompt"]["inputs"]["text"] == "blurry"


def test_build_workflow_wan21_frames_snap(wf21):
    built, meta = build_workflow(wf21, "wan21", image="a.png", prompt="x", frames=100)
    nodes = resolve_workflow(built, is_dual=False)
    assert nodes["WanImageToVideo"]["inputs"]["length"] == 101  # nearest 4n+1
    assert meta["frames"] == 101


def test_build_workflow_wan22_dual(wf22):
    built, meta = build_workflow(wf22, "wan22", image="a.png", prompt="x", frames=81, steps=5, seed=3)
    nodes = resolve_workflow(built, is_dual=True)
    # odd steps -> even (5 -> 6)
    assert nodes["ksampler high"]["inputs"]["steps"] == 6
    assert nodes["ksampler low"]["inputs"]["steps"] == 6
    # high/low start/end from resolved steps
    assert nodes["ksampler high"]["inputs"]["start_at_step"] == 0
    assert nodes["ksampler high"]["inputs"]["end_at_step"] == 3
    assert nodes["ksampler low"]["inputs"]["start_at_step"] == 3
    assert nodes["ksampler low"]["inputs"]["end_at_step"] == 10000
    # models
    assert nodes["unet high"]["inputs"]["unet_name"] == "Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-high-nvfp4.safetensors"
    assert nodes["unet low"]["inputs"]["unet_name"] == "Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-low-nvfp4.safetensors"
    # samplers
    assert nodes["ksampler high"]["inputs"]["sampler_name"] == "heun"
    assert nodes["ksampler low"]["inputs"]["sampler_name"] == "euler"
    # NAG
    assert nodes["nag high"]["inputs"]["nag_scale"] == 11
    assert nodes["nag low"]["inputs"]["nag_scale"] == 11
    assert meta["steps"] == 6


def test_build_workflow_wan22_even_steps_unchanged(wf22):
    built, meta = build_workflow(wf22, "wan22", image="a.png", prompt="x", steps=4)
    nodes = resolve_workflow(built, is_dual=True)
    assert nodes["ksampler high"]["inputs"]["steps"] == 4
    assert nodes["ksampler high"]["inputs"]["end_at_step"] == 2
    assert nodes["ksampler low"]["inputs"]["start_at_step"] == 2
    assert meta["steps"] == 4


def test_build_workflow_wan22_loras_per_path(wf22):
    built, _ = build_workflow(
        wf22, "wan22", image="a.png", prompt="x",
        lora_config='[{"name": "lora_high.sft", "path": "high"}, {"name": "lora_both.sft"}]',
    )
    nodes = resolve_workflow(built, is_dual=True)
    high_loader = nodes["lora high"]["inputs"]
    low_loader = nodes["lora low"]["inputs"]
    # high: gets both (explicit high + unspecified)
    assert high_loader["lora_1"]["lora"] == "lora_high.sft"
    assert high_loader["lora_2"]["lora"] == "lora_both.sft"
    # low: only the unspecified one (loader LOW has a single slot)
    assert low_loader["lora_1"]["lora"] == "lora_both.sft"
    assert low_loader["lora_1"]["on"] is True
    assert "lora_2" not in low_loader


def test_build_workflow_validations(wf21, wf22):
    with pytest.raises(VideoError):
        build_workflow(wf21, "wan21", image="", prompt="x")
    with pytest.raises(VideoError):
        build_workflow(wf21, "wan21", image="a.png", prompt="   ")
    with pytest.raises(VideoError):
        build_workflow(wf21, "wan21", image="a.png", prompt="x", steps=99)
    with pytest.raises(VideoError):
        build_workflow(wf21, "nope", image="a.png", prompt="x")


def test_deep_copy_not_mutating_source(wf21):
    built, _ = build_workflow(wf21, "wan21", image="a.png", prompt="x", frames=100, steps=6, seed=4)
    assert wf21["998"]["inputs"]["length"] == 81  # original untouched
    assert built["998"]["inputs"]["length"] == 101
