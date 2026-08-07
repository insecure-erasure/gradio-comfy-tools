"""Tests for tools.generate — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools import _common
from tools.generate import (
    FAMILY_OPTIONS,
    MODEL_CONFIGS,
    build_workflow,
    load_workflow,
    normalize_aspect_ratio,
    resolve_workflow,
    GenerateError,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_families_match_reference():
    # spot-check against MODEL_CONFIGS in smart_generate_image/tool.py
    z = MODEL_CONFIGS["zimage"]
    assert z["model"] == "zImageTurbo-mxfp8.safetensors"
    assert z["vae_scale_factor"] == 16
    assert z["clip_type"] == "lumina2"
    f = MODEL_CONFIGS["flux2"]
    assert f["model"] == "flux-2-klein-9b-nvfp4.safetensors"
    assert f["vae_scale_factor"] == 64
    assert f["sigma_selector_index"] == 2
    assert f["scheduler"] == ""


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for t in [
        "Load Diffusion Model",
        "Load CLIP",
        "Load VAE",
        "Prompt",
        "Flux Resolution Calc",
        "Aspect ratio",
        "Steps",
        "CFGGuider",
        "KSamplerSelect",
        "BasicScheduler",
        "Switch (SIGMAS)",
        "RandomNoise",
        "Power Lora Loader (rgthree)",
        "Random Preview Image",
    ]:
        assert t in nodes, f"missing node {t}"


def test_build_workflow_defaults(wf):
    built, meta = build_workflow(wf, family="zimage", prompt="hello")
    assert meta["family"] == "zimage"
    # model config injected
    nodes = resolve_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "zImageTurbo-mxfp8.safetensors"
    assert nodes["Load CLIP"]["inputs"]["clip_name"] == "qwen3_4b_instruct_2507_mxfp8.safetensors"
    assert nodes["Load CLIP"]["inputs"]["type"] == "lumina2"
    assert nodes["Load VAE"]["inputs"]["vae_name"] == "Z-Image_half_natural_vae.safetensors"
    # resolution
    assert nodes["Flux Resolution Calc"]["inputs"]["megapixel"] == "1.0"
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "16"
    assert nodes["Aspect ratio"]["inputs"]["string_a"] == "2"
    assert nodes["Aspect ratio"]["inputs"]["string_b"] == "3"
    # steps default 10, seed resolved (random for -1)
    assert nodes["Steps"]["inputs"]["value"] == 10
    assert nodes["BasicScheduler"]["inputs"]["steps"] == 10
    assert 0 <= nodes["RandomNoise"]["inputs"]["noise_seed"] <= _common.COMFY_SEED_MAX
    assert nodes["CFGGuider"]["inputs"]["cfg"] == 1.0
    assert nodes["KSamplerSelect"]["inputs"]["sampler_name"] == "euler"
    assert nodes["BasicScheduler"]["inputs"]["scheduler"] == "simple"
    assert nodes["Switch (SIGMAS)"]["inputs"]["select"] == 1


def test_build_workflow_flux2(wf):
    built, meta = build_workflow(wf, family="flux2", prompt="hello", steps=8, seed=42)
    nodes = resolve_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "flux-2-klein-9b-nvfp4.safetensors"
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "64"
    # flux2 leaves scheduler empty (uses Flux2Scheduler)
    assert nodes["BasicScheduler"]["inputs"]["scheduler"] == "simple"  # workflow default
    assert nodes["Switch (SIGMAS)"]["inputs"]["select"] == 2
    assert nodes["RandomNoise"]["inputs"]["noise_seed"] == 42


def test_build_workflow_explicit_params(wf):
    built, meta = build_workflow(
        wf, family="krea2", prompt="hi", aspect_ratio="16:9", megapixel=2.0, steps=15, seed=7
    )
    assert (meta["reduced_w"], meta["reduced_h"]) == (16, 9)
    nodes = resolve_workflow(built)
    assert nodes["Aspect ratio"]["inputs"]["string_a"] == "16"
    assert nodes["Aspect ratio"]["inputs"]["string_b"] == "9"
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "8"
    assert nodes["Flux Resolution Calc"]["inputs"]["megapixel"] == "2.0"
    assert nodes["Steps"]["inputs"]["value"] == 15
    assert nodes["RandomNoise"]["inputs"]["noise_seed"] == 7


def test_build_workflow_model_override(wf):
    """⚙️ advanced: ``model`` overrides the family default unet_name."""
    built, meta = build_workflow(
        wf, family="zimage", prompt="hi", model="my-custom-model.safetensors"
    )
    nodes = resolve_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "my-custom-model.safetensors"
    # empty model keeps the family default
    built2, _ = build_workflow(wf, family="flux2", prompt="hi")
    nodes2 = resolve_workflow(built2)
    assert nodes2["Load Diffusion Model"]["inputs"]["unet_name"] == "flux-2-klein-9b-nvfp4.safetensors"
    with pytest.raises(GenerateError):
        build_workflow(wf, family="zimage", prompt="hi", model="../evil.json")


def test_build_workflow_loras(wf):
    built, meta = build_workflow(
        wf,
        family="flux2",
        prompt="hi",
        lora_config='[{"name": "flux2/Flux2-Klein-Image-RestoreV1.safetensors", "strength": 1.0}]',
    )
    nodes = resolve_workflow(built)
    loader = nodes["Power Lora Loader (rgthree)"]["inputs"]
    assert loader["lora_1"]["on"] is True
    assert loader["lora_1"]["lora"] == "flux2/Flux2-Klein-Image-RestoreV1.safetensors"
    assert loader["lora_1"]["strength"] == 1.0
    # disabled slots stay off
    assert loader["lora_2"]["on"] is False


def test_build_workflow_validations(wf):
    with pytest.raises(GenerateError):
        build_workflow(wf, family="nope", prompt="hi")
    with pytest.raises(GenerateError):
        build_workflow(wf, prompt="   ")
    with pytest.raises(GenerateError):
        build_workflow(wf, prompt="hi", steps=99)
    with pytest.raises(GenerateError):
        build_workflow(wf, prompt="hi", megapixel=5.0)
    with pytest.raises(GenerateError):
        build_workflow(wf, prompt="hi", aspect_ratio="bogus")


def test_normalize_aspect_ratio():
    assert normalize_aspect_ratio("16:9") == (16, 9)
    assert normalize_aspect_ratio("1920x1080") == (16, 9)
    assert normalize_aspect_ratio("2:3") == (2, 3)
    with pytest.raises(GenerateError):
        normalize_aspect_ratio("abc")
    with pytest.raises(GenerateError):
        normalize_aspect_ratio("1.5:1")


def test_deep_copy_not_mutating_source(wf):
    built, _ = build_workflow(wf, family="krea2", prompt="hi", steps=15)
    assert wf["484"]["inputs"]["value"] == 8  # untouched original (krea2 default steps 8)
    assert built["484"]["inputs"]["value"] == 15
