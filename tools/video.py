"""Video tool — generate_video.json / generate_video_wan22.json workflows.

Turns an image into a video with Wan 2.1 (single path) or Wan 2.2 (dual
high/low path): injects the image source, positive prompt (+ optional
negative), VAE/CLIP, frames (4n+1 snap), seed, steps (even for wan22),
per-path diffusion models + samplers + NAG + ModelSamplingSD3 shift, LoRAs
per path, then submits via ComfyClient and returns the output MP4 URL.

Mirrors generate_video/tool.py (VIDEO_MODEL_CONFIGS).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common
from tools._common import WorkflowError

WORKFLOW_DIR = "workflows"

VIDEO_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "wan21": {
        "workflow_file": "generate_video.json",
        "diffusion_model": "Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v-nvfp4.safetensors",
        "sampler": "euler",
        "scheduler": "simple",
        "steps": 4,
        "cfg": 1.0,
        "model_sampling_shift": 5,
        "nag_scale": 11,
        "nag_alpha": 0.25,
        "nag_tau": 2.5,
    },
    "wan22": {
        "workflow_file": "generate_video_wan22.json",
        "high": {
            "diffusion_model": "Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-high-nvfp4.safetensors",
            "sampler": "heun",
            "scheduler": "simple",
            "steps": 4,
            "cfg": 1.0,
            "start_at_step": 0,
            "end_at_step": 2,
            "add_noise": "enable",
            "return_with_leftover_noise": "enable",
            "model_sampling_shift": 5,
            "nag_scale": 11,
            "nag_alpha": 0.25,
            "nag_tau": 2.5,
        },
        "low": {
            "diffusion_model": "Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-low-nvfp4.safetensors",
            "sampler": "euler",
            "scheduler": "simple",
            "steps": 4,
            "cfg": 1.0,
            "start_at_step": 2,
            "end_at_step": 10000,
            "add_noise": "disable",
            "return_with_leftover_noise": "disable",
            "model_sampling_shift": 5,
            "nag_scale": 11,
            "nag_alpha": 0.25,
            "nag_tau": 2.5,
        },
    },
}

MODEL_VERSIONS = list(VIDEO_MODEL_CONFIGS.keys())
DEFAULT_MODEL_VERSION = "wan21"

MIN_STEPS, MAX_STEPS = 4, 10
DEFAULT_FRAMES = 81


class VideoError(ValueError):
    """User-facing parameter validation error."""


def load_workflow(model_version: str) -> dict[str, dict]:
    cfg = VIDEO_MODEL_CONFIGS[model_version]
    return _common.load_workflow_json(Path(WORKFLOW_DIR) / cfg["workflow_file"])


def resolve_workflow(workflow: dict[str, dict], is_dual: bool) -> dict[str, dict]:
    """Resolve common nodes + per-path nodes (single or dual)."""
    titles = [
        "Positive Prompt",
        "Negative Prompt",
        "Default Wan negative prompt",
        "Load Image (URL/Path)",
        "Load VAE",
        "CLIPLoader (GGUF)",
        "WanImageToVideo",
        "EasySeed",
        "Conditioning (Concat)",
        "Unsharpen mask",
        "Image Blend",
        "RTX Video Super Resolution",
        "Frame Interpolate",
        "Load Frame Interpolation Model",
        "Output MP4",
    ]
    resolved: dict[str, dict] = {}
    for t in titles:
        _, node = _common.resolve_node(workflow, t)
        resolved[t] = node

    if is_dual:
        for path_name in ("high", "low"):
            suffix = f" {path_name.upper()}"
            resolved[f"unet {path_name}"] = _common.resolve_node(workflow, f"Load Diffusion Model{suffix}")[1]
            resolved[f"lora {path_name}"] = _common.resolve_node(workflow, f"Power Lora Loader (rgthree){suffix}")[1]
            resolved[f"msampling {path_name}"] = _common.resolve_node(workflow, f"ModelSamplingSD3{suffix}")[1]
            resolved[f"nag {path_name}"] = _common.resolve_node(workflow, f"NAG {path_name.upper()}")[1]
            resolved[f"ksampler {path_name}"] = _common.resolve_node(workflow, f"KSampler {path_name.upper()}")[1]
    else:
        resolved["unet main"] = _common.resolve_node(workflow, "Load Diffusion Model")[1]
        resolved["lora main"] = _common.resolve_node(workflow, "Power Lora Loader (rgthree)")[1]
        resolved["msampling main"] = _common.resolve_node(workflow, "ModelSamplingSD3")[1]
        resolved["nag main"] = _common.resolve_node(workflow, "NAG HIGH")[1]
        resolved["ksampler main"] = _common.resolve_node(workflow, "KSampler")[1]
    return resolved


def _filter_loras_for_path(parsed_loras: list[Any], path: str) -> list[dict]:
    """Filter a parsed lora_config to those applicable to the given path."""
    out: list[dict] = []
    for item in parsed_loras:
        if isinstance(item, str):
            out.append({"model": item, "strength": 1.0, "paths": None})
        elif isinstance(item, dict):
            name = item.get("name", item.get("model", ""))
            strength = float(item.get("strength", 1.0))
            item_path = item.get("path")
            if item_path is None or item_path == path:
                out.append({"model": name, "strength": strength, "paths": item_path})
    return out


def build_workflow(
    workflow: dict[str, dict],
    model_version: str,
    *,
    image: str,
    prompt: str = "",
    negative_prompt: str = "",
    frames: int = DEFAULT_FRAMES,
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    if model_version not in VIDEO_MODEL_CONFIGS:
        raise VideoError(f"Unknown model version {model_version!r}; options: {MODEL_VERSIONS}")
    cfg = VIDEO_MODEL_CONFIGS[model_version]
    is_dual = "high" in cfg
    if not image.strip():
        raise VideoError("image must not be empty")
    prompt = prompt.strip()
    if not prompt:
        raise VideoError("prompt must not be empty")
    resolved_steps = int(steps) if steps else int(cfg.get("steps", 4))
    if not (MIN_STEPS <= resolved_steps <= MAX_STEPS):
        raise VideoError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {resolved_steps}")
    if is_dual and resolved_steps % 2 != 0:
        resolved_steps += 1  # wan22: odd -> even (rounded up)
    resolved_frames = _common.snap_frames(frames)
    seed_arg = _common.resolve_seed(seed)
    loras = _common.parse_lora_config(lora_config)

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf, is_dual)

    # Positive / negative prompt
    nodes["Positive Prompt"]["inputs"]["text"] = prompt
    if negative_prompt.strip():
        nodes["Negative Prompt"]["inputs"]["text"] = negative_prompt.strip()

    # Image source
    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)

    # VAE / CLIP (always injected from defaults)
    nodes["Load VAE"]["inputs"]["vae_name"] = "wan_2.1_vae.safetensors"
    nodes["CLIPLoader (GGUF)"]["inputs"]["clip_name"] = "umt5-xxl-encoder-Q5_K_M.gguf"
    nodes["CLIPLoader (GGUF)"]["inputs"]["type"] = "wan"

    # Frames / seed
    nodes["WanImageToVideo"]["inputs"]["length"] = resolved_frames
    nodes["EasySeed"]["inputs"]["seed"] = seed_arg

    # Per-path values
    if is_dual:
        for path_name in ("high", "low"):
            pc = cfg[path_name]
            k = nodes[f"ksampler {path_name}"]
            k["inputs"]["sampler_name"] = pc["sampler"]
            k["inputs"]["scheduler"] = pc["scheduler"]
            k["inputs"]["cfg"] = pc["cfg"]
            k["inputs"]["steps"] = resolved_steps
            # dual: start/end recomputed from resolved steps (always even)
            half = resolved_steps // 2
            k["inputs"]["start_at_step"] = 0 if path_name == "high" else half
            k["inputs"]["end_at_step"] = half if path_name == "high" else 10000
            k["inputs"]["add_noise"] = pc["add_noise"]
            k["inputs"]["return_with_leftover_noise"] = pc["return_with_leftover_noise"]
            nodes[f"unet {path_name}"]["inputs"]["unet_name"] = pc["diffusion_model"]
            nodes[f"msampling {path_name}"]["inputs"]["shift"] = pc["model_sampling_shift"]
            nodes[f"nag {path_name}"]["inputs"]["nag_scale"] = pc["nag_scale"]
            nodes[f"nag {path_name}"]["inputs"]["nag_alpha"] = pc["nag_alpha"]
            nodes[f"nag {path_name}"]["inputs"]["nag_tau"] = pc["nag_tau"]
            _common.apply_loras(nodes[f"lora {path_name}"]["inputs"], _filter_loras_for_path(loras, path_name))
    else:
        pc = cfg
        k = nodes["ksampler main"]
        k["inputs"]["sampler_name"] = pc["sampler"]
        k["inputs"]["scheduler"] = pc["scheduler"]
        k["inputs"]["cfg"] = pc["cfg"]
        k["inputs"]["steps"] = resolved_steps
        nodes["unet main"]["inputs"]["unet_name"] = pc["diffusion_model"]
        nodes["msampling main"]["inputs"]["shift"] = pc["model_sampling_shift"]
        nodes["nag main"]["inputs"]["nag_scale"] = pc["nag_scale"]
        nodes["nag main"]["inputs"]["nag_alpha"] = pc["nag_alpha"]
        nodes["nag main"]["inputs"]["nag_tau"] = pc["nag_tau"]
        _common.apply_loras(nodes["lora main"]["inputs"], _filter_loras_for_path(loras, "main"))

    meta = {
        "model_version": model_version,
        "frames": resolved_frames,
        "steps": resolved_steps,
        "seed": seed_arg,
        "image": image,
    }
    return wf, meta


def generate_video(
    settings: Settings,
    *,
    image: str,
    model_version: str = DEFAULT_MODEL_VERSION,
    prompt: str = "",
    negative_prompt: str = "",
    frames: int = DEFAULT_FRAMES,
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    timeout: float = 300.0,
) -> str:
    """Run the Video workflow and return the output MP4 URL."""
    workflow = load_workflow(model_version)
    wf, meta = build_workflow(
        workflow,
        model_version,
        image=image,
        prompt=prompt,
        negative_prompt=negative_prompt,
        frames=frames,
        steps=steps,
        seed=seed,
        lora_config=lora_config,
    )
    with ComfyClient(settings=settings) as client:
        prompt_id = client.queue_prompt(wf)
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    video = _common.find_output_video(outputs)
    return client.result_url(video["filename"], video.get("type", "output"))
