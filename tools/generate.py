"""Generate tool — smart_generate_image.json (+ the zit_var.json variant).

Injects the model family config (model / CLIP / VAE / cfg / steps / sampler /
scheduler), the prompt, the resolution (megapixel + aspect ratio via
Flux Resolution Calc), steps, seed and LoRAs into the workflow, then submits
it via ComfyClient and returns the output image URL.

``build_variability_workflow`` is the "Increase randomness" variant
(zit_var.json): a two-stage sampler graph shared by Z-Image Turbo and Krea 2
where only the injection map changes (model stack, prompt/resolution/steps/
seed/LoRAs/initial conditioning and the first-step threshold), never the
technique.

MODEL_CONFIGS mirrors the reference smart_generate_image/tool.py, except
``vae_scale_factor``, which is 16 for every family here so the resolution
aligns with each model's native grid (Krea 2 and FLUX.2 official inference
align to 16; the reference used 8 for Krea 2 and 64 for FLUX.2).
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
# "Increase randomness" variant: a two-stage sampler graph that makes the
# seed matter much more than the single-stage workflow above. The same graph
# serves every family listed in VARIABILITY_CONFIGS below.
VARIABILITY_WORKFLOW_FILE = "workflows/zit_var.json"
VARIABILITY_FAMILY = "zimage"  # default family for variability mode

MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "zimage": {
        "model": "zImageTurbo-mxfp8.safetensors",
        "text_encoder": "qwen3_4b_instruct_2507_mxfp8.safetensors",
        "vae": "Z-Image_half_natural_vae.safetensors",
        "vae_scale_factor": 16,
        "cfg": 1.0,
        "steps": 10,
        "sampler": "euler",
        "scheduler": "simple",
        "clip_type": "lumina2",
        "sigma_selector_index": 1,
    },
    "krea2": {
        "model": "krea2_turbo_mixed_nvfp4.safetensors",
        "text_encoder": "qwen3_vl_4b_instruct_mxfp8.safetensors",
        "vae": "qwen_image_vae.safetensors",
        "vae_scale_factor": 16,
        "cfg": 1.0,
        "steps": 8,
        "sampler": "euler",
        "scheduler": "simple",
        "clip_type": "krea2",
        "sigma_selector_index": 1,
    },
    "flux2": {
        "model": "flux-2-klein-9b-nvfp4.safetensors",
        "text_encoder": "qwen_3_8b_nvfp4.safetensors",
        "vae": "flux2-vae-small-bf16.safetensors",
        "vae_scale_factor": 16,
        "cfg": 1.0,
        "steps": 8,
        "sampler": "euler",
        "scheduler": "",
        "clip_type": "flux2",
        "sigma_selector_index": 2,
    },
}

FAMILY_OPTIONS = list(MODEL_CONFIGS.keys())

# Per-family knobs for the two-stage "Increase randomness" workflow. The
# technique itself (res_multistep + shift 7 for step 0, euler + shift 2.5
# afterwards, cfg 1 and the timestep-gated conditioning) is fixed in
# zit_var.json and is shared by both families — validated with Krea 2 too.
# Only the model stack (MODEL_CONFIGS), the step budget and the first-step
# threshold change per family. ``divisible_by`` is 16 for both: Z-Image Turbo
# uses its VAE scale factor, and Krea 2 aligns to 16 as its official inference
# code does (Qwen-Image VAE 8x x Krea 2 patch 2), avoiding the internal
# circular padding ComfyUI applies for odd latent dimensions.
VARIABILITY_CONFIGS: dict[str, dict[str, Any]] = {
    "zimage": {
        "steps": 10,
        "timestep_threshold": 0.105,
        "divisible_by": 16,
    },
    "krea2": {
        "steps": 9,
        "timestep_threshold": 0.112,
        "divisible_by": 16,
    },
}

VARIABILITY_FAMILIES = list(VARIABILITY_CONFIGS.keys())

DEFAULT_FAMILY = "zimage"
DEFAULT_ASPECT_RATIO = "2:3"
DEFAULT_MEGAPIXEL = 1.0
MIN_STEPS, MAX_STEPS = 1, 15
# The two-stage graph splits one schedule: stage 1 runs step 0 and stage 2
# runs 1..N, so N must be at least 2 for stage 2 to execute at all.
MIN_VARIABILITY_STEPS = 2


class GenerateError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def load_variability_workflow() -> dict[str, dict]:
    """Load the high-variability workflow (zit_var.json)."""
    return _common.load_workflow_json(VARIABILITY_WORKFLOW_FILE)


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
    """Resolve the high-variability workflow nodes by _meta.title."""
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
) -> dict[str, Any]:
    """Validate + normalize the parameters shared by both Generate workflows.

    ``family_cfg`` supplies the default step count. Returns the normalized
    model/prompt/steps, the reduced W:H and the resolved seed + parsed LoRAs,
    so each builder only has to map them onto its own nodes.
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
        "seed": _common.resolve_seed(seed),
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

    Available for every family in ``VARIABILITY_CONFIGS`` (Z-Image Turbo and
    Krea 2). The two-stage sampler technique is fixed in the workflow and
    must NOT be overridden: res_multistep + shift 7 for the first step,
    euler + shift 2.5 afterwards, the timestep-gated conditioning and cfg 1
    (validated experimentally with Krea 2 as well). Only the model stack,
    prompt, resolution, steps, seed, LoRAs, the model override, the initial
    conditioning and the family-specific first-step threshold are injected.

    The seed goes to ``KSampler (Advanced) 1`` only. ``KSampler (Advanced)
    2`` runs with ``add_noise: disable`` (ComfyUI ignores its ``noise_seed``)
    so it stays at its fixed 0. The same step count goes to both stages —
    they split a single 0..N schedule. The LoRA loader feeds the second
    stage only, which is deliberate.
    """
    if family not in VARIABILITY_CONFIGS:
        raise GenerateError(
            f"Variability mode is only available for {VARIABILITY_FAMILIES} "
            f"(Z-Image Turbo / Krea 2), got {family!r}"
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
    the two-stage high-variability workflow; it works for Z-Image Turbo and
    Krea 2 and is rejected for any other family. ``initial_conditioning`` is
    the conditioning that replaces the prompt for the first timestep slice of
    that workflow (ignored otherwise).
    """
    if variability:
        workflow = load_variability_workflow()
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
