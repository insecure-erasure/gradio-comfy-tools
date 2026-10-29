"""Generate tool — smart_generate_image.json (+ the variability variants).

Injects the model family config (model / CLIP / VAE / cfg / steps / sampler /
scheduler), the prompt, the resolution (megapixel + aspect ratio via
Flux Resolution Calc), steps, seed and LoRAs into the workflow, then submits
it via ComfyClient and returns the output image URL.

``build_variability_workflow`` is the "Increase randomness" variant:
Z-Image Turbo and Krea 2 share ``dit_var.json`` (KSamplerAdvanced split
schedule); FLUX.2 uses ``flux2_var.json`` (Flux2Scheduler + SplitSigmas +
two SamplerCustomAdvanced stages). Only the injection map changes (model
stack, prompt/resolution/steps/seed/LoRAs/initial conditioning and the
first-step threshold), never the technique.

``FAMILY_CONFIGS`` is the single source of truth for the family data.
``MODEL_CONFIGS`` and ``VARIABILITY_CONFIGS`` are derived views kept for
compatibility. ``vae_scale_factor`` is 16 for every family here so the
resolution aligns with each model's native grid (Krea 2 and FLUX.2 official
inference align to 16; the reference used 8 for Krea 2 and 64 for FLUX.2).
"""

from __future__ import annotations

import json
import math
import random
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common
from tools._common import WorkflowError

WORKFLOW_FILE = "workflows/smart_generate_image.json"
VARIABILITY_FAMILY = "zimage"  # default family for variability mode

# Single source of truth for the Generate families. ``standard`` feeds the
# single-stage workflow; ``variability`` feeds the two-stage "Increase
# randomness" workflow (Z-Image/Krea 2 share dit_var.json; FLUX.2 uses
# flux2_var.json). MODEL_CONFIGS / VARIABILITY_CONFIGS /
# VARIABILITY_WORKFLOW_FILES below are derived views kept for compatibility.
FAMILY_CONFIGS: dict[str, dict[str, Any]] = {
    "zimage": {
        "model": "zImageTurbo-mxfp8.safetensors",
        "text_encoder": "qwen3_4b_instruct_2507_mxfp8.safetensors",
        "vae": "Z-Image_half_natural_vae.safetensors",
        "clip_type": "lumina2",
        "standard": {
            "vae_scale_factor": 16,
            "cfg": 1.0,
            "steps": 10,
            "sampler": "euler",
            "scheduler": "simple",
            "sigma_selector_index": 1,
        },
        "variability": {
            "workflow": "workflows/dit_var.json",
            "steps": 10,
            "timestep_threshold": 0.105,
            "divisible_by": 16,
        },
    },
    "krea2": {
        "model": "krea2_turbo_mixed_nvfp4.safetensors",
        "text_encoder": "qwen3_vl_4b_instruct_mxfp8.safetensors",
        "vae": "qwen_image_vae.safetensors",
        "clip_type": "krea2",
        "standard": {
            "vae_scale_factor": 16,
            "cfg": 1.0,
            "steps": 8,
            "sampler": "euler",
            "scheduler": "simple",
            "sigma_selector_index": 1,
        },
        "variability": {
            "workflow": "workflows/dit_var.json",
            "steps": 9,
            "timestep_threshold": 0.112,
            "divisible_by": 16,
        },
    },
    "flux2": {
        "model": "flux-2-klein-9b-nvfp4.safetensors",
        "text_encoder": "qwen_3_8b_nvfp4.safetensors",
        "vae": "flux2-vae-small-bf16.safetensors",
        "clip_type": "flux2",
        "standard": {
            "vae_scale_factor": 16,
            "cfg": 1.0,
            "steps": 8,
            "sampler": "euler",
            "scheduler": "",
            "sigma_selector_index": 2,
        },
        "variability": {
            "workflow": "workflows/flux2_var.json",
            "steps": 8,
            "timestep_threshold": 0.13,
            "divisible_by": 16,
        },
    },
}

# Derived views with the same shapes/keys as the previous hand-written dicts.
MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    family: {
        "model": cfg["model"],
        "text_encoder": cfg["text_encoder"],
        "vae": cfg["vae"],
        "vae_scale_factor": cfg["standard"]["vae_scale_factor"],
        "cfg": cfg["standard"]["cfg"],
        "steps": cfg["standard"]["steps"],
        "sampler": cfg["standard"]["sampler"],
        "scheduler": cfg["standard"]["scheduler"],
        "clip_type": cfg["clip_type"],
        "sigma_selector_index": cfg["standard"]["sigma_selector_index"],
    }
    for family, cfg in FAMILY_CONFIGS.items()
}

VARIABILITY_CONFIGS: dict[str, dict[str, Any]] = {
    family: {
        "steps": cfg["variability"]["steps"],
        "timestep_threshold": cfg["variability"]["timestep_threshold"],
        "divisible_by": cfg["variability"]["divisible_by"],
    }
    for family, cfg in FAMILY_CONFIGS.items()
}

VARIABILITY_WORKFLOW_FILES: dict[str, str] = {
    family: cfg["variability"]["workflow"]
    for family, cfg in FAMILY_CONFIGS.items()
}

FAMILY_OPTIONS = list(FAMILY_CONFIGS.keys())
VARIABILITY_FAMILIES = list(VARIABILITY_CONFIGS.keys())

DEFAULT_FAMILY = "zimage"
DEFAULT_ASPECT_RATIO = "2:3"
DEFAULT_MEGAPIXEL = 1.0
MIN_STEPS, MAX_STEPS = 1, 15
# Generate seeds go to RandomNoise or KSampler/KsamplerAdvanced, which accept
# the full uint64 range. FLUX.2 uses this explicitly; the other Generate
# builders use the same default.
RANDOM_NOISE_SEED_MAX = _common.UINT64_SEED_MAX
# The two-stage graph splits one schedule: stage 1 runs step 0 and stage 2
# runs 1..N, so N must be at least 2 for stage 2 to execute at all.
MIN_VARIABILITY_STEPS = 2


class GenerateError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def load_variability_workflow(family: str = VARIABILITY_FAMILY) -> dict[str, dict]:
    """Load the high-variability workflow for ``family``."""
    try:
        path = VARIABILITY_WORKFLOW_FILES[family]
    except KeyError:
        raise GenerateError(
            f"No variability workflow for {family!r}; options: {VARIABILITY_FAMILIES}"
        ) from None
    return _common.load_workflow_json(path)


def _resolve_nodes(workflow: dict[str, dict], titles: list[str]) -> dict[str, dict]:
    """Resolve each title to its node (raises on missing/ambiguous titles)."""
    return {t: _common.resolve_node(workflow, t)[1] for t in titles}


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    """Resolve all Generate workflow nodes by _meta.title."""
    return _resolve_nodes(workflow, [
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
    ])


def resolve_variability_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    """Resolve the dit_var.json (Z-Image Turbo / Krea 2) nodes by title."""
    return _resolve_nodes(workflow, [
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
    ])


def resolve_flux2_variability_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    """Resolve the flux2_var.json (FLUX.2) nodes by title."""
    return _resolve_nodes(workflow, [
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
    ])


def normalize_aspect_ratio(raw: str) -> tuple[int, int]:
    """'16:9' or '1920x1080' -> reduced W:H (by GCD). Raises GenerateError."""
    s = raw.strip().lower().replace("x", ":")
    parts = s.split(":")
    if len(parts) != 2:
        raise GenerateError(
            f"Invalid aspect ratio format: {raw!r}. Use W:H (e.g. 16:9) or WxH (e.g. 1920x1080)."
        )
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError:
        raise GenerateError(
            f"Invalid numbers in aspect ratio: {raw!r}. Both parts must be integers."
        ) from None
    if w <= 0 or h <= 0:
        raise GenerateError(f"Aspect ratio must be positive: {raw!r}")
    g = math.gcd(w, h)
    return w // g, h // g


def _normalize_params(
    *,
    prompt: str,
    steps: int,
    family_cfg: dict[str, Any],
    megapixel: float,
    aspect_ratio: str,
    seed: int,
    lora_config: str,
    model: str,
    seed_max: int = _common.UINT64_SEED_MAX,
) -> dict[str, Any]:
    """Validate + normalize the parameters shared by both Generate workflows.

    ``family_cfg`` supplies the default step count. Returns the normalized
    model/prompt/steps, the reduced W:H and the resolved seed + parsed LoRAs,
    so each builder only has to map them onto its own nodes. ``seed_max``
    defaults to the uint64 range used by RandomNoise/KSampler nodes.
    """
    model = model.strip()
    if model.endswith((".json", ".yaml", ".yml")):
        raise GenerateError("model must be a model filename, not a workflow file")
    prompt = prompt.strip()
    if not prompt:
        raise GenerateError("prompt must not be empty")
    if steps == 0:
        steps = int(family_cfg["steps"])
    if not (MIN_STEPS <= steps <= MAX_STEPS):
        raise GenerateError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {steps}")
    if not (0.1 <= megapixel <= 2.0):
        raise GenerateError(f"megapixel must be in [0.1, 2.0], got {megapixel}")
    reduced_w, reduced_h = normalize_aspect_ratio(aspect_ratio)
    return {
        "model": model,
        "prompt": prompt,
        "steps": steps,
        "reduced_w": reduced_w,
        "reduced_h": reduced_h,
        "seed": _common.resolve_seed(seed, max_value=seed_max),
        "loras": _common.parse_lora_config(lora_config),
    }


def build_workflow(
    workflow: dict[str, dict],
    *,
    family: str = DEFAULT_FAMILY,
    prompt: str = "",
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    megapixel: float = DEFAULT_MEGAPIXEL,
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    model: str = "",
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow.

    Returns ``(workflow, meta)`` where ``meta`` carries resolved info for
    logging/tests: reduced W:H, resolved steps, resolved seed, family config.
    """
    if family not in MODEL_CONFIGS:
        raise GenerateError(f"Unknown family {family!r}; options: {FAMILY_OPTIONS}")
    cfg = MODEL_CONFIGS[family]
    p = _normalize_params(
        prompt=prompt,
        steps=steps,
        family_cfg=cfg,
        megapixel=megapixel,
        aspect_ratio=aspect_ratio,
        seed=seed,
        lora_config=lora_config,
        model=model,
    )

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    # Model config — ``model`` (from the ⚙️ advanced modal) overrides the
    # family default when provided.
    nodes["Load Diffusion Model"]["inputs"]["unet_name"] = p["model"] or cfg["model"]
    nodes["Load CLIP"]["inputs"]["clip_name"] = cfg["text_encoder"]
    nodes["Load CLIP"]["inputs"]["type"] = cfg["clip_type"]
    nodes["Load VAE"]["inputs"]["vae_name"] = cfg["vae"]

    # Resolution
    nodes["Flux Resolution Calc"]["inputs"]["megapixel"] = str(megapixel)
    nodes["Flux Resolution Calc"]["inputs"]["aspect_ratio"] = "2:3 (Classic Portrait)"
    nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] = str(cfg["vae_scale_factor"])
    nodes["Aspect ratio"]["inputs"]["string_a"] = str(p["reduced_w"])
    nodes["Aspect ratio"]["inputs"]["string_b"] = str(p["reduced_h"])

    # Prompt / steps / seed / cfg / sampler
    nodes["Prompt"]["inputs"]["value"] = p["prompt"]
    nodes["Steps"]["inputs"]["value"] = p["steps"]
    nodes["BasicScheduler"]["inputs"]["steps"] = p["steps"]
    nodes["RandomNoise"]["inputs"]["noise_seed"] = p["seed"]
    nodes["CFGGuider"]["inputs"]["cfg"] = cfg["cfg"]
    nodes["KSamplerSelect"]["inputs"]["sampler_name"] = cfg["sampler"]

    # Scheduler — only override when the family defines one (flux2 uses
    # Flux2Scheduler internally; leaving "simple" avoids validation errors on
    # unused-but-connected nodes)
    if cfg["scheduler"]:
        nodes["BasicScheduler"]["inputs"]["scheduler"] = cfg["scheduler"]

    # Sigma selector: 1 = BasicScheduler (zimage/krea2), 2 = Flux2Scheduler (flux2)
    nodes["Switch (SIGMAS)"]["inputs"]["select"] = cfg["sigma_selector_index"]

    # LoRAs
    _common.apply_loras(nodes["Power Lora Loader (rgthree)"]["inputs"], p["loras"])

    meta = {
        "family": family,
        "reduced_w": p["reduced_w"],
        "reduced_h": p["reduced_h"],
        "steps": p["steps"],
        "seed": p["seed"],
        "megapixel": megapixel,
    }
    return wf, meta


def _build_flux2_variability_workflow(
    workflow: dict[str, dict],
    *,
    family: str = "flux2",
    prompt: str = "",
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    megapixel: float = DEFAULT_MEGAPIXEL,
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    model: str = "",
    initial_conditioning: str = "",
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into the FLUX.2 high-variability workflow.

    ``flux2_var.json`` runs a single ``Flux2Scheduler`` through
    ``SplitSigmas(step=1)``: stage 1 consumes the high sigmas (one step) and
    stage 2 the low sigmas (steps - 1), reusing stage 1's latent with
    ``DisableNoise`` so it continues the same schedule. The samplers
    (res_multistep / euler), shifts, cfg and graph topology are fixed by the
    technique; only the model stack, prompt, resolution, steps, seed, LoRAs,
    initial conditioning and first-step threshold are injected.
    """
    if family != "flux2":
        raise GenerateError(f"FLUX.2 variability requires family='flux2', got {family!r}")
    cfg = MODEL_CONFIGS[family]
    vcfg = VARIABILITY_CONFIGS[family]
    p = _normalize_params(
        prompt=prompt,
        steps=steps,
        family_cfg=vcfg,
        megapixel=megapixel,
        aspect_ratio=aspect_ratio,
        seed=seed,
        lora_config=lora_config,
        model=model,
        seed_max=RANDOM_NOISE_SEED_MAX,
    )
    if p["steps"] < MIN_VARIABILITY_STEPS:
        raise GenerateError(
            f"steps must be >= {MIN_VARIABILITY_STEPS} in variability mode "
            f"(stage 1 takes one step, stage 2 the remaining steps), got {p['steps']}"
        )

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_flux2_variability_workflow(wf)

    # Model stack (MODEL_CONFIGS["flux2"] defaults; ``model`` overrides the UNET)
    nodes["Load Diffusion Model"]["inputs"]["unet_name"] = p["model"] or cfg["model"]
    nodes["Load CLIP"]["inputs"]["clip_name"] = cfg["text_encoder"]
    nodes["Load CLIP"]["inputs"]["type"] = cfg["clip_type"]
    nodes["Load VAE"]["inputs"]["vae_name"] = cfg["vae"]

    # Resolution (custom ratio via the StringConcatenate node)
    nodes["Flux Resolution Calc"]["inputs"]["megapixel"] = str(megapixel)
    nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] = str(vcfg["divisible_by"])
    nodes["Aspect ratio"]["inputs"]["string_a"] = str(p["reduced_w"])
    nodes["Aspect ratio"]["inputs"]["string_b"] = str(p["reduced_h"])

    # Prompt + initial conditioning + first-step threshold
    nodes["Prompt here"]["inputs"]["text"] = p["prompt"]
    nodes["Initial conditioning"]["inputs"]["text"] = initial_conditioning.strip()
    nodes["ConditioningTimestepThreshold"]["inputs"]["value"] = vcfg["timestep_threshold"]
    _common.apply_loras(nodes["Power Lora Loader (rgthree)"]["inputs"], p["loras"])

    # One schedule split at step 1; the seed feeds stage 1's RandomNoise.
    nodes["Flux2Scheduler"]["inputs"]["steps"] = p["steps"]
    nodes["RandomNoise"]["inputs"]["noise_seed"] = p["seed"]

    meta = {
        "family": family,
        "reduced_w": p["reduced_w"],
        "reduced_h": p["reduced_h"],
        "steps": p["steps"],
        "seed": p["seed"],
        "megapixel": megapixel,
        "divisible_by": vcfg["divisible_by"],
        "timestep_threshold": vcfg["timestep_threshold"],
        "variability": True,
        "workflow": "flux2_var.json",
    }
    return wf, meta


def build_variability_workflow(
    workflow: dict[str, dict],
    *,
    family: str = VARIABILITY_FAMILY,
    prompt: str = "",
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    megapixel: float = DEFAULT_MEGAPIXEL,
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    model: str = "",
    initial_conditioning: str = "",
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the high-variability workflow.

    Z-Image Turbo and Krea 2 use ``dit_var.json`` (this function); FLUX.2 is
    dispatched to ``_build_flux2_variability_workflow`` because it uses the
    Flux2Scheduler + SplitSigmas graph. The two-stage sampler technique is
    fixed in each workflow and must NOT be overridden. Only the model stack,
    prompt, resolution, steps, seed, LoRAs, the model override, the initial
    conditioning and the family-specific first-step threshold are injected.

    For dit_var, the seed goes to ``KSampler (Advanced) 1`` only. ``KSampler
    (Advanced) 2`` runs with ``add_noise: disable`` (ComfyUI ignores its
    ``noise_seed``) so it stays at its fixed 0. The same step count goes to
    both stages — they split a single 0..N schedule. The LoRA loader feeds
    the second stage only, which is deliberate.
    """
    if family == "flux2":
        return _build_flux2_variability_workflow(
            workflow,
            family=family,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            megapixel=megapixel,
            steps=steps,
            seed=seed,
            lora_config=lora_config,
            model=model,
            initial_conditioning=initial_conditioning,
        )
    if family not in VARIABILITY_CONFIGS:
        raise GenerateError(
            f"Variability mode is only available for {VARIABILITY_FAMILIES} "
            f"(Z-Image Turbo / Krea 2 / FLUX.2), got {family!r}"
        )
    cfg = MODEL_CONFIGS[family]
    vcfg = VARIABILITY_CONFIGS[family]
    p = _normalize_params(
        prompt=prompt,
        steps=steps,
        family_cfg=vcfg,
        megapixel=megapixel,
        aspect_ratio=aspect_ratio,
        seed=seed,
        lora_config=lora_config,
        model=model,
    )
    if p["steps"] < MIN_VARIABILITY_STEPS:
        raise GenerateError(
            f"steps must be >= {MIN_VARIABILITY_STEPS} in variability mode "
            f"(the two samplers split one schedule), got {p['steps']}"
        )

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_variability_workflow(wf)

    # Model config (the family defaults; ``model`` from the advanced modal
    # overrides the UNET). Krea 2 gets its own encoder/VAE/clip type.
    nodes["Load Diffusion Model"]["inputs"]["unet_name"] = p["model"] or cfg["model"]
    nodes["Load CLIP"]["inputs"]["clip_name"] = cfg["text_encoder"]
    nodes["Load CLIP"]["inputs"]["type"] = cfg["clip_type"]
    nodes["Load VAE"]["inputs"]["vae_name"] = cfg["vae"]

    # Resolution (custom ratio via the StringConcatenate node)
    nodes["Flux Resolution Calc"]["inputs"]["megapixel"] = str(megapixel)
    nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] = str(vcfg["divisible_by"])
    nodes["Aspect ratio"]["inputs"]["string_a"] = str(p["reduced_w"])
    nodes["Aspect ratio"]["inputs"]["string_b"] = str(p["reduced_h"])

    # Prompt + LoRAs
    nodes["Prompt here"]["inputs"]["text"] = p["prompt"]
    # Conditioning used instead of the prompt for the first timestep slice;
    # defaults to "" — the workflow's original behaviour.
    nodes["Initial conditioning"]["inputs"]["text"] = initial_conditioning.strip()
    # Fraction of the schedule during which stage 1 ignores the prompt
    # (0.105 for Z-Image Turbo, 0.112 for Krea 2).
    nodes["ConditioningTimestepThreshold"]["inputs"]["value"] = vcfg["timestep_threshold"]
    _common.apply_loras(nodes["Power Lora Loader (rgthree)"]["inputs"], p["loras"])

    # Same step count in both stages; seed only in the first stage
    nodes["KSampler (Advanced) 1"]["inputs"]["steps"] = p["steps"]
    nodes["KSampler (Advanced) 2"]["inputs"]["steps"] = p["steps"]
    nodes["KSampler (Advanced) 1"]["inputs"]["noise_seed"] = p["seed"]

    meta = {
        "family": family,
        "reduced_w": p["reduced_w"],
        "reduced_h": p["reduced_h"],
        "steps": p["steps"],
        "seed": p["seed"],
        "megapixel": megapixel,
        "divisible_by": vcfg["divisible_by"],
        "timestep_threshold": vcfg["timestep_threshold"],
        "variability": True,
        "workflow": "dit_var.json",
    }
    return wf, meta


def generate_image(
    settings: Settings,
    *,
    family: str = DEFAULT_FAMILY,
    prompt: str = "",
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    megapixel: float = DEFAULT_MEGAPIXEL,
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    model: str = "",
    timeout: float = 120.0,
    variability: bool = False,
    initial_conditioning: str = "",
) -> str:
    """Run the Generate workflow and return the output image URL.

    ``variability=True`` (the "Increase randomness" advanced option) selects
    the two-stage high-variability workflow for the family: dit_var.json for
    Z-Image Turbo / Krea 2, flux2_var.json for FLUX.2. Other families are
    rejected. ``initial_conditioning`` is the conditioning that replaces the
    prompt for the first timestep slice of that workflow (ignored otherwise).
    """
    if variability:
        workflow = load_variability_workflow(family)
        wf, meta = build_variability_workflow(
            workflow,
            family=family,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            megapixel=megapixel,
            steps=steps,
            seed=seed,
            lora_config=lora_config,
            model=model,
            initial_conditioning=initial_conditioning,
        )
    else:
        workflow = load_workflow()
        wf, meta = build_workflow(
            workflow,
            family=family,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            megapixel=megapixel,
            steps=steps,
            seed=seed,
            lora_config=lora_config,
            model=model,
        )
    with ComfyClient(settings=settings) as client:
        # preview_method: auto — the sampler decodes its intermediate latent
        # each step (tiny VAE / latent2rgb) and streams JPEG previews over
        # the WS, which server.py's job listener captures for the live
        # preview in the Generate tab. Only enabled here (image tools); the
        # flag is per-prompt and reset after execution.
        prompt_id = client.queue_prompt(wf, extra_data={"preview_method": "auto"})
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image = _common.find_output_image(outputs)
    return client.result_url(image["filename"], image.get("type", "output"))
