"""Tests for tools.generate — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools import _common
from tools.generate import (
    FAMILY_OPTIONS,
    MODEL_CONFIGS,
    RANDOM_NOISE_SEED_MAX,
    VARIABILITY_CONFIGS,
    VARIABILITY_FAMILY,
    VARIABILITY_FAMILIES,
    build_variability_workflow,
    build_workflow,
    load_variability_workflow,
    load_workflow,
    normalize_aspect_ratio,
    resolve_flux2_variability_workflow,
    resolve_variability_workflow,
    resolve_workflow,
    GenerateError,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_families_match_reference():
    # spot-check the family configs (Krea 2 aligns to 16, not the reference's
    # VAE scale of 8 — see docs/BACKEND.md §5.1)
    z = MODEL_CONFIGS["zimage"]
    assert z["model"] == "zImageTurbo-mxfp8.safetensors"
    assert z["vae_scale_factor"] == 16
    assert z["clip_type"] == "lumina2"
    k = MODEL_CONFIGS["krea2"]
    assert k["vae"] == "qwen_image_vae.safetensors"
    assert k["vae_scale_factor"] == 16
    assert k["clip_type"] == "krea2"
    f = MODEL_CONFIGS["flux2"]
    assert f["model"] == "flux-2-klein-9b-nvfp4.safetensors"
    assert f["vae_scale_factor"] == 16
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
    assert 0 <= nodes["RandomNoise"]["inputs"]["noise_seed"] <= RANDOM_NOISE_SEED_MAX
    assert nodes["CFGGuider"]["inputs"]["cfg"] == 1.0
    assert nodes["KSamplerSelect"]["inputs"]["sampler_name"] == "euler"
    assert nodes["BasicScheduler"]["inputs"]["scheduler"] == "simple"
    assert nodes["Switch (SIGMAS)"]["inputs"]["select"] == 1


def test_build_workflow_flux2(wf):
    built, meta = build_workflow(wf, family="flux2", prompt="hello", steps=8, seed=42)
    nodes = resolve_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "flux-2-klein-9b-nvfp4.safetensors"
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "16"
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
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "16"
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


# --------------------------------------------------------------------------- #
# Variability workflow (dit_var.json) — "Increase randomness" (Z-Image Turbo /
# Krea 2)
# --------------------------------------------------------------------------- #
@pytest.fixture
def vwf():
    return load_variability_workflow()


@pytest.fixture
def fvwf():
    return load_variability_workflow("flux2")


def test_variability_resolve_titles(vwf):
    nodes = resolve_variability_workflow(vwf)
    for t in [
        "Load Diffusion Model",
        "Load CLIP",
        "Load VAE",
        "Aspect ratio",
        "Flux Resolution Calc",
        "Prompt here",
        "Initial conditioning",
        "ConditioningTimestepThreshold",
        "Power Lora Loader (rgthree)",
        "KSampler (Advanced) 1",
        "KSampler (Advanced) 2",
        "Random Preview Image",
    ]:
        assert t in nodes, f"missing node {t}"


def test_variability_build_defaults(vwf):
    built, meta = build_variability_workflow(vwf, prompt="hello")
    assert meta["variability"] is True
    assert meta["family"] == VARIABILITY_FAMILY
    nodes = resolve_variability_workflow(built)
    # zimage config
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "zImageTurbo-mxfp8.safetensors"
    assert nodes["Load CLIP"]["inputs"]["clip_name"] == "qwen3_4b_instruct_2507_mxfp8.safetensors"
    assert nodes["Load CLIP"]["inputs"]["type"] == "lumina2"
    assert nodes["Load VAE"]["inputs"]["vae_name"] == "Z-Image_half_natural_vae.safetensors"
    # resolution
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "16"
    assert nodes["Aspect ratio"]["inputs"]["string_a"] == "2"
    assert nodes["Aspect ratio"]["inputs"]["string_b"] == "3"
    assert nodes["ConditioningTimestepThreshold"]["inputs"]["value"] == 0.105
    assert nodes["Prompt here"]["inputs"]["text"] == "hello"
    # steps go to BOTH stages (same value)
    assert nodes["KSampler (Advanced) 1"]["inputs"]["steps"] == 10
    assert nodes["KSampler (Advanced) 2"]["inputs"]["steps"] == 10
    # seed goes to stage 1 only; stage 2 stays fixed at 0
    assert 0 <= nodes["KSampler (Advanced) 1"]["inputs"]["noise_seed"] <= RANDOM_NOISE_SEED_MAX
    assert nodes["KSampler (Advanced) 2"]["inputs"]["noise_seed"] == 0
    # the technique (samplers/schedulers/shifts/cfg) is never touched
    assert nodes["KSampler (Advanced) 1"]["inputs"]["sampler_name"] == "res_multistep"
    assert nodes["KSampler (Advanced) 2"]["inputs"]["sampler_name"] == "euler"
    assert nodes["KSampler (Advanced) 1"]["inputs"]["cfg"] == 1
    assert nodes["KSampler (Advanced) 2"]["inputs"]["add_noise"] == "disable"


def test_variability_build_krea2_defaults(vwf):
    """Krea 2 uses the same graph with its own model stack and 9 steps."""
    built, meta = build_variability_workflow(vwf, family="krea2", prompt="hello")
    assert meta["family"] == "krea2"
    assert meta["steps"] == 9
    assert meta["timestep_threshold"] == 0.112
    nodes = resolve_variability_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "krea2_turbo_mixed_nvfp4.safetensors"
    assert nodes["Load CLIP"]["inputs"]["clip_name"] == "qwen3_vl_4b_instruct_mxfp8.safetensors"
    assert nodes["Load CLIP"]["inputs"]["type"] == "krea2"
    assert nodes["Load VAE"]["inputs"]["vae_name"] == "qwen_image_vae.safetensors"
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "16"
    assert nodes["ConditioningTimestepThreshold"]["inputs"]["value"] == 0.112
    # schedule split: 0 -> 1 (stage 1) and 1 -> 10000 (stage 2), steps 9
    assert nodes["KSampler (Advanced) 1"]["inputs"]["steps"] == 9
    assert nodes["KSampler (Advanced) 1"]["inputs"]["start_at_step"] == 0
    assert nodes["KSampler (Advanced) 1"]["inputs"]["end_at_step"] == 1
    assert nodes["KSampler (Advanced) 2"]["inputs"]["steps"] == 9
    assert nodes["KSampler (Advanced) 2"]["inputs"]["start_at_step"] == 1
    assert nodes["KSampler (Advanced) 2"]["inputs"]["end_at_step"] == 10000
    # the technique is shared with Z-Image Turbo
    assert nodes["KSampler (Advanced) 1"]["inputs"]["sampler_name"] == "res_multistep"
    assert nodes["KSampler (Advanced) 2"]["inputs"]["sampler_name"] == "euler"


def test_flux2_variability_resolve_titles(fvwf):
    nodes = resolve_flux2_variability_workflow(fvwf)
    for t in [
        "Load Diffusion Model",
        "Load CLIP",
        "Load VAE",
        "Aspect ratio",
        "Flux Resolution Calc",
        "Prompt here",
        "Initial conditioning",
        "ConditioningTimestepThreshold",
        "Power Lora Loader (rgthree)",
        "Flux2Scheduler",
        "SplitSigmas",
        "SamplerCustomAdvanced 1",
        "SamplerCustomAdvanced 2",
        "DisableNoise",
        "RandomNoise",
        "CFGGuider 1",
        "CFGGuider 2",
        "KSamplerSelect 1",
        "KSamplerSelect 2",
        "Random Preview Image",
    ]:
        assert t in nodes, f"missing node {t}"


def test_flux2_variability_build_defaults(fvwf):
    built, meta = build_variability_workflow(fvwf, family="flux2", prompt="hello")
    assert meta["family"] == "flux2"
    assert meta["steps"] == 8
    assert meta["timestep_threshold"] == 0.13
    assert meta["divisible_by"] == 16
    assert meta["workflow"] == "flux2_var.json"
    nodes = resolve_flux2_variability_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "flux-2-klein-9b-nvfp4.safetensors"
    assert nodes["Load CLIP"]["inputs"]["clip_name"] == "qwen_3_8b_nvfp4.safetensors"
    assert nodes["Load CLIP"]["inputs"]["type"] == "flux2"
    assert nodes["Load VAE"]["inputs"]["vae_name"] == "flux2-vae-small-bf16.safetensors"
    assert nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] == "16"
    assert nodes["ConditioningTimestepThreshold"]["inputs"]["value"] == 0.13
    assert nodes["Prompt here"]["inputs"]["text"] == "hello"
    assert nodes["Flux2Scheduler"]["inputs"]["steps"] == 8
    assert nodes["SplitSigmas"]["inputs"]["step"] == 1
    assert nodes["KSamplerSelect 1"]["inputs"]["sampler_name"] == "res_multistep"
    assert nodes["KSamplerSelect 2"]["inputs"]["sampler_name"] == "euler"
    assert nodes["CFGGuider 1"]["inputs"]["cfg"] == 1
    assert nodes["CFGGuider 2"]["inputs"]["cfg"] == 1
    assert 0 <= nodes["RandomNoise"]["inputs"]["noise_seed"] <= RANDOM_NOISE_SEED_MAX

    # One schedule split at step 1: high -> stage 1, low -> stage 2, and
    # stage 2 continues from stage 1's latent with no new noise.
    split_id, _ = _common.resolve_node(built, "SplitSigmas")
    stage1_id, _ = _common.resolve_node(built, "SamplerCustomAdvanced 1")
    stage2_id, _ = _common.resolve_node(built, "SamplerCustomAdvanced 2")
    disable_id, _ = _common.resolve_node(built, "DisableNoise")
    assert built[stage1_id]["inputs"]["sigmas"] == [split_id, 0]
    assert built[stage2_id]["inputs"]["sigmas"] == [split_id, 1]
    assert built[stage2_id]["inputs"]["noise"] == [disable_id, 0]
    assert built[stage2_id]["inputs"]["latent_image"] == [stage1_id, 0]


def test_flux2_variability_explicit_params(fvwf):
    built, meta = build_variability_workflow(
        fvwf,
        family="flux2",
        prompt="hi",
        aspect_ratio="16:9",
        megapixel=2.0,
        steps=12,
        seed=42,
    )
    assert (meta["reduced_w"], meta["reduced_h"]) == (16, 9)
    nodes = resolve_flux2_variability_workflow(built)
    assert nodes["Aspect ratio"]["inputs"]["string_a"] == "16"
    assert nodes["Aspect ratio"]["inputs"]["string_b"] == "9"
    assert nodes["Flux2Scheduler"]["inputs"]["steps"] == 12
    assert nodes["SplitSigmas"]["inputs"]["step"] == 1
    assert nodes["RandomNoise"]["inputs"]["noise_seed"] == 42


def test_flux2_variability_model_lora_and_conditioning(fvwf):
    built, _ = build_variability_workflow(
        fvwf,
        family="flux2",
        prompt="hi",
        model="my-custom.safetensors",
        lora_config='[{"name": "flux2/foo.safetensors", "strength": 0.8}]',
        initial_conditioning="  blurry  ",
    )
    nodes = resolve_flux2_variability_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "my-custom.safetensors"
    assert nodes["Initial conditioning"]["inputs"]["text"] == "blurry"
    loader = nodes["Power Lora Loader (rgthree)"]["inputs"]
    # The workflow only defines lora_2; apply_loras must fill it.
    assert loader["lora_2"]["on"] is True
    assert loader["lora_2"]["lora"] == "flux2/foo.safetensors"
    assert loader["lora_2"]["strength"] == 0.8


def test_flux2_variability_validations(fvwf):
    with pytest.raises(GenerateError):
        build_variability_workflow(fvwf, family="flux2", prompt="hi", steps=1)
    with pytest.raises(GenerateError):
        build_variability_workflow(fvwf, family="flux2", prompt="   ")


def test_flux2_variability_preserves_uint64_seed(fvwf):
    # RandomNoise.noise_seed accepts uint64; the Generate seed must not be
    # clamped to uint32 for this flow.
    seed = 99910461318452
    built, meta = build_variability_workflow(fvwf, family="flux2", prompt="hi", seed=seed)
    nodes = resolve_flux2_variability_workflow(built)
    assert meta["seed"] == seed
    assert nodes["RandomNoise"]["inputs"]["noise_seed"] == seed


def test_flux2_variability_deep_copy_not_mutating_source(fvwf):
    built, _ = build_variability_workflow(fvwf, family="flux2", prompt="hi", steps=12, seed=7)
    assert fvwf["100"]["inputs"]["steps"] == 8
    assert fvwf["103"]["inputs"]["noise_seed"] == 0
    assert built["100"]["inputs"]["steps"] == 12
    assert built["103"]["inputs"]["noise_seed"] == 7


def test_variability_family_configs_cover_supported_families():
    assert set(VARIABILITY_CONFIGS) == {"zimage", "krea2", "flux2"}
    assert set(VARIABILITY_FAMILIES) == set(VARIABILITY_CONFIGS)
    assert VARIABILITY_FAMILY in VARIABILITY_CONFIGS


def test_variability_explicit_params(vwf):
    built, meta = build_variability_workflow(
        vwf, prompt="hi", aspect_ratio="16:9", megapixel=2.0, steps=12, seed=42
    )
    assert (meta["reduced_w"], meta["reduced_h"]) == (16, 9)
    nodes = resolve_variability_workflow(built)
    assert nodes["Aspect ratio"]["inputs"]["string_a"] == "16"
    assert nodes["Aspect ratio"]["inputs"]["string_b"] == "9"
    assert nodes["KSampler (Advanced) 1"]["inputs"]["steps"] == 12
    assert nodes["KSampler (Advanced) 2"]["inputs"]["steps"] == 12
    assert nodes["KSampler (Advanced) 1"]["inputs"]["noise_seed"] == 42
    assert nodes["KSampler (Advanced) 2"]["inputs"]["noise_seed"] == 0


def test_variability_model_override_and_loras(vwf):
    built, _ = build_variability_workflow(
        vwf,
        prompt="hi",
        model="my-custom.safetensors",
        lora_config='[{"name": "zit/foo.safetensors", "strength": 0.8}]',
    )
    nodes = resolve_variability_workflow(built)
    assert nodes["Load Diffusion Model"]["inputs"]["unet_name"] == "my-custom.safetensors"
    loader = nodes["Power Lora Loader (rgthree)"]["inputs"]
    assert loader["lora_1"]["on"] is True
    assert loader["lora_1"]["lora"] == "zit/foo.safetensors"
    assert loader["lora_1"]["strength"] == 0.8


def test_variability_initial_conditioning(vwf):
    # Default: the workflow's original empty conditioning ("").
    built, _ = build_variability_workflow(vwf, prompt="hi")
    assert resolve_variability_workflow(built)["Initial conditioning"]["inputs"]["text"] == ""
    # The advanced "Initial conditioning" field overrides it (stripped).
    built2, _ = build_variability_workflow(vwf, prompt="hi", initial_conditioning="  blurry  ")
    assert resolve_variability_workflow(built2)["Initial conditioning"]["inputs"]["text"] == "blurry"


def test_variability_rejects_other_families(vwf):
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, family="nope", prompt="hi")
    with pytest.raises(GenerateError):
        load_variability_workflow("nope")


def test_variability_validations(vwf):
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, prompt="   ")
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, prompt="hi", steps=99)
    # 1 step would leave the second sampler with nothing to run
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, prompt="hi", steps=1)
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, prompt="hi", megapixel=5.0)
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, prompt="hi", aspect_ratio="bogus")
    with pytest.raises(GenerateError):
        build_variability_workflow(vwf, prompt="hi", model="../evil.json")


def test_variability_deep_copy_not_mutating_source(vwf):
    built, _ = build_variability_workflow(vwf, prompt="hi", steps=12, seed=7)
    assert vwf["75"]["inputs"]["steps"] == 10
    assert vwf["75"]["inputs"]["noise_seed"] == 0
    assert vwf["90:93"]["inputs"]["value"] == 0.105
    assert built["75"]["inputs"]["steps"] == 12
    assert built["75"]["inputs"]["noise_seed"] == 7


def test_variability_krea2_not_mutating_source(vwf):
    built, _ = build_variability_workflow(vwf, family="krea2", prompt="hi")
    assert vwf["90:93"]["inputs"]["value"] == 0.105
    assert vwf["89"]["inputs"]["clip_name"] == "qwen3_4b_instruct_2507_mxfp8.safetensors"
    assert built["90:93"]["inputs"]["value"] == 0.112
    assert built["89"]["inputs"]["clip_name"] == "qwen3_vl_4b_instruct_mxfp8.safetensors"
