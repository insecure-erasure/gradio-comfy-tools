"""Generate tool — smart_generate_image.json workflow.

Injects the model family config (model / CLIP / VAE / cfg / steps / sampler /
scheduler), the prompt, the resolution (megapixel + aspect ratio via
Flux Resolution Calc), steps, seed and LoRAs into the workflow, then submits
it via ComfyClient and returns the output image URL.

MODEL_CONFIGS mirrors the reference smart_generate_image/tool.py.
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
        "vae_scale_factor": 8,
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
        "vae_scale_factor": 64,
        "cfg": 1.0,
        "steps": 8,
        "sampler": "euler",
        "scheduler": "",
        "clip_type": "flux2",
        "sigma_selector_index": 2,
    },
}

FAMILY_OPTIONS = list(MODEL_CONFIGS.keys())

DEFAULT_FAMILY = "zimage"
DEFAULT_ASPECT_RATIO = "2:3"
DEFAULT_MEGAPIXEL = 1.0
MIN_STEPS, MAX_STEPS = 1, 15


class GenerateError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    from pathlib import Path

    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    """Resolve all Generate workflow nodes by _meta.title."""
    titles = [
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
    ]
    resolved: dict[str, dict] = {}
    for t in titles:
        _, node = _common.resolve_node(workflow, t)
        resolved[t] = node
    return resolved


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
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow.

    Returns ``(workflow, meta)`` where ``meta`` carries resolved info for
    logging/tests: reduced W:H, resolved steps, resolved seed, family config.
    """
    if family not in MODEL_CONFIGS:
        raise GenerateError(f"Unknown family {family!r}; options: {FAMILY_OPTIONS}")
    prompt = prompt.strip()
    if not prompt:
        raise GenerateError("prompt must not be empty")
    cfg = MODEL_CONFIGS[family]
    if steps == 0:
        steps = int(cfg["steps"])
    if not (MIN_STEPS <= steps <= MAX_STEPS):
        raise GenerateError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {steps}")
    if not (0.1 <= megapixel <= 2.0):
        raise GenerateError(f"megapixel must be in [0.1, 2.0], got {megapixel}")
    reduced_w, reduced_h = normalize_aspect_ratio(aspect_ratio)
    seed_arg = _common.resolve_seed(seed)
    loras = _common.parse_lora_config(lora_config)

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    # Model config
    nodes["Load Diffusion Model"]["inputs"]["unet_name"] = cfg["model"]
    nodes["Load CLIP"]["inputs"]["clip_name"] = cfg["text_encoder"]
    nodes["Load CLIP"]["inputs"]["type"] = cfg["clip_type"]
    nodes["Load VAE"]["inputs"]["vae_name"] = cfg["vae"]

    # Resolution
    nodes["Flux Resolution Calc"]["inputs"]["megapixel"] = str(megapixel)
    nodes["Flux Resolution Calc"]["inputs"]["aspect_ratio"] = "2:3 (Classic Portrait)"
    nodes["Flux Resolution Calc"]["inputs"]["divisible_by"] = str(cfg["vae_scale_factor"])
    nodes["Aspect ratio"]["inputs"]["string_a"] = str(reduced_w)
    nodes["Aspect ratio"]["inputs"]["string_b"] = str(reduced_h)

    # Prompt / steps / seed / cfg / sampler
    nodes["Prompt"]["inputs"]["value"] = prompt
    nodes["Steps"]["inputs"]["value"] = steps
    nodes["BasicScheduler"]["inputs"]["steps"] = steps
    nodes["RandomNoise"]["inputs"]["noise_seed"] = seed_arg
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
    _common.apply_loras(nodes["Power Lora Loader (rgthree)"]["inputs"], loras)

    meta = {
        "family": family,
        "reduced_w": reduced_w,
        "reduced_h": reduced_h,
        "steps": steps,
        "seed": seed_arg,
        "megapixel": megapixel,
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
    timeout: float = 120.0,
) -> str:
    """Run the Generate workflow and return the output image URL."""
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
    )
    with ComfyClient(settings=settings) as client:
        prompt_id = client.queue_prompt(wf)
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image = _common.find_output_image(outputs)
    return client.result_url(image["filename"], image.get("type", "output"))
