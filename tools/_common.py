"""Shared workflow-injection helpers for the per-tab tools.

Mirrors the patterns in the Open WebUI reference tools
(../open-webui-comfy-tools): resolve nodes by unique ``_meta.title``, configure
the LoadImageByUrlOrPath node via filename-vs-URL auto-detection, snap video
frames to 4n+1, resolve -1 seeds to random, and apply LoRA configs to the
rgthree Power Lora Loader (growing slots as needed).
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Seed ranges: KSampler accepts uint64; some nodes (SeedVR2VideoUpscaler)
# cap at uint32. resolve_seed uses a safe default of uint32 so it works
# across all workflows.
COMFY_SEED_MAX = 4294967295  # uint32 (safe across all workflow nodes)

# WAN temporal VAE stride: valid frame counts are 4n+1
VIDEO_MIN_FRAMES = 81
VIDEO_MAX_FRAMES = 161


class WorkflowError(ValueError):
    """A workflow node referenced by title was not found or is ambiguous."""


# --------------------------------------------------------------------------- #
# Workflow loading
# --------------------------------------------------------------------------- #
def load_workflow_json(path: str | Path) -> dict[str, dict]:
    """Load and parse a workflow JSON file (validates it is a dict of nodes)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise WorkflowError(f"Workflow {path} is not a JSON object")
    return data


def find_output_image(outputs: dict[str, Any]) -> dict[str, Any]:
    """First image in the history outputs (Random Preview Image node).

    Returns the image record ``{"filename", "subfolder", "type"}``.
    """
    for node_out in outputs.values():
        for img in node_out.get("images", []):
            return img
    raise WorkflowError(f"No image found in outputs: {outputs}")


def find_output_video(outputs: dict[str, Any]) -> dict[str, Any]:
    """First video in the history outputs (VHS_VideoCombine).

    Returns the video record ``{"filename", "subfolder", "type"}`` from
    either the ``videos`` or ``gifs`` output key.
    """
    for node_out in outputs.values():
        for key in ("videos", "gifs"):
            for v in node_out.get(key, []):
                return v
    raise WorkflowError(f"No video found in outputs: {outputs}")


# --------------------------------------------------------------------------- #
# Node resolution
# --------------------------------------------------------------------------- #
def resolve_node(workflow: dict[str, dict], title: str) -> tuple[str, dict]:
    """Find a workflow node by its unique ``_meta.title``.

    Returns ``(node_id, node_dict)``. Raises WorkflowError if the title is
    missing or not unique.
    """
    matches = [
        (node_id, node)
        for node_id, node in workflow.items()
        if node.get("_meta", {}).get("title") == title
    ]
    if not matches:
        titles = sorted(
            {
                node.get("_meta", {}).get("title")
                for node in workflow.values()
                if isinstance(node, dict)
            }
            - {None}
        )
        raise WorkflowError(
            f"Node with title {title!r} not found in workflow. "
            f"Available titles: {titles}"
        )
    if len(matches) > 1:
        raise WorkflowError(f"Node with title {title!r} is not unique ({len(matches)} matches)")
    return matches[0]


# --------------------------------------------------------------------------- #
# Source image (LoadImageByUrlOrPath) — filename vs URL auto-detection
# --------------------------------------------------------------------------- #
def is_external_url(value: str) -> bool:
    """True if the value is an absolute http(s) URL."""
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def normalize_source(image: str) -> tuple[str, str]:
    """Centralized filename-vs-URL auto-detection.

    Returns ``(value, kind)`` where ``kind`` is ``"url"`` for external URLs
    and ``"filename"`` otherwise (ComfyUI-internal filename). Shared by the
    Edit/Upscale/Video image-source flow.
    """
    if is_external_url(image):
        return image, "url"
    return image, "filename"


def configure_image_node(node_inputs: dict[str, Any], image: str) -> None:
    """Write the source image into a LoadImageByUrlOrPath node's inputs.

    External URL -> ``source="url"`` + ``url`` (drops ``image``);
    otherwise     -> ``source="temp"`` + ``image`` (ComfyUI-internal filename).
    Always drops the "Choose file to upload" widget key.
    """
    node_inputs.pop("Choose file to upload", None)
    if is_external_url(image):
        node_inputs["source"] = "url"
        node_inputs["url"] = image
        node_inputs.pop("image", None)
    else:
        node_inputs["source"] = "temp"
        node_inputs["image"] = image
        node_inputs["url"] = ""


# --------------------------------------------------------------------------- #
# Seed / frames
# --------------------------------------------------------------------------- #
def resolve_seed(seed: int) -> int:
    """-1 -> random uint64; >=0 -> clamped to the ComfyUI seed range."""
    if seed == -1:
        return random.randint(0, COMFY_SEED_MAX)
    return min(seed, COMFY_SEED_MAX)


def snap_frames(n: int, min_frames: int = VIDEO_MIN_FRAMES, max_frames: int = VIDEO_MAX_FRAMES) -> int:
    """Snap to the nearest valid frame count (4n+1), clamped.

    Exact mirror of ``_snap_to_valid_frames`` in the reference
    generate_video/tool.py (verified identical for n=1..199).
    """
    n = max(min_frames, min(n, max_frames))
    snapped = ((n - 1) // 4) * 4 + 1
    if n - snapped > 2:
        snapped += 4
    return min(snapped, max_frames)


# --------------------------------------------------------------------------- #
# LoRAs (rgthree Power Lora Loader)
# --------------------------------------------------------------------------- #
# Strength bounds: ComfyUI itself accepts any number (each LoRA defines its own
# working range), but values beyond ±10 are never meaningful and are usually
# typos. The API rejects them with a clear error; the UI clamps to the same
# range so nothing out of bounds can be submitted.
LORA_STRENGTH_MIN = -10.0
LORA_STRENGTH_MAX = 10.0


def parse_lora_config(raw: str) -> list[Any]:
    """Parse a lora_config JSON string into a list of str-or-dict items.

    Items: ``"name"`` (strength 1.0) or ``{"name"|"model": ..., "strength": ...}``.
    Raises ValueError with a user-facing message on malformed input or a
    strength outside ``LORA_STRENGTH_MIN..LORA_STRENGTH_MAX``.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"lora_config is not valid JSON: {e}") from e
    if not isinstance(parsed, list):
        raise ValueError(
            f"lora_config must be a JSON array, got {type(parsed).__name__}. "
            'Example: ["lora1.sft", {"name": "lora2.sft", "strength": 0.5}]'
        )
    for i, item in enumerate(parsed):
        if isinstance(item, str):
            continue
        if isinstance(item, dict):
            name = item.get("name", item.get("model"))
            if not isinstance(name, str):
                raise ValueError(
                    f"lora_config[{i}] must have a string 'name'/'model', "
                    f"got {type(name).__name__}"
                )
            strength = item.get("strength", 1.0)
            if not isinstance(strength, (int, float)):
                raise ValueError(
                    f"lora_config[{i}] 'strength' must be a number, "
                    f"got {type(strength).__name__}"
                )
            if not (LORA_STRENGTH_MIN <= strength <= LORA_STRENGTH_MAX):
                raise ValueError(
                    f"lora_config[{i}] 'strength' must be between "
                    f"{LORA_STRENGTH_MIN:g} and {LORA_STRENGTH_MAX:g}, "
                    f"got {strength:g}"
                )
            continue
        raise ValueError(
            f"lora_config[{i}] must be a string or object, got {type(item).__name__}"
        )
    return parsed


def apply_loras(loader_inputs: dict[str, Any], loras: list[Any]) -> None:
    """Fill the Power Lora Loader slots from a parsed lora_config.

    Applied positionally to ``lora_1..lora_N``; grows the workflow with extra
    slots when there are more LoRAs than the loader defines (rgthree nodes use
    FlexibleOptionalInputType, like the reference). An empty name disables the
    slot. Any numeric strength is applied as-is — 0, fractional (0<|s|<1) and
    negative strengths are all valid in ComfyUI and must NOT disable the slot.
    """
    max_slots = sum(1 for k in loader_inputs if k.startswith("lora_"))
    for i in range(max_slots + 1, len(loras) + 1):
        loader_inputs[f"lora_{i}"] = {"on": False, "lora": "", "strength": 0}

    for i, item in enumerate(loras, start=1):
        slot = f"lora_{i}"
        if slot not in loader_inputs:
            break
        if isinstance(item, str):
            name, strength = item, 1.0
        elif isinstance(item, dict):
            name = item.get("name", item.get("model", ""))
            strength = float(item.get("strength", 1.0))
        else:
            continue

        if bool(name):
            loader_inputs[slot]["on"] = True
            loader_inputs[slot]["lora"] = name
            loader_inputs[slot]["strength"] = strength
        else:
            loader_inputs[slot]["on"] = False
            loader_inputs[slot]["lora"] = ""
            loader_inputs[slot]["strength"] = 0


# --------------------------------------------------------------------------- #
# Model names — OS-independent basename matching
# --------------------------------------------------------------------------- #
def match_by_basename(names: list[str], basename: str) -> str | None:
    """Find the entry of a ComfyUI model-folder listing whose basename matches.

    ComfyUI reports subfolder paths with the OS separator (``/`` on
    Linux/macOS, ``\\`` on Windows — users often dual-boot the same model
    folder), and core loader nodes (e.g. the strict ``LoraLoaderModelOnly``
    combo) only accept the exact string the server lists. Matching by
    basename (PurePosixPath-style: both separators treated the same,
    case-insensitive — same canonicalization as dev/check_env.py and the
    frontend's purePath shim) lets a tool look up the installed name and
    send it back verbatim, so the injected value always passes ComfyUI's
    validation regardless of the host OS. Returns None when nothing matches.
    """
    wanted = basename.replace("\\", "/").rsplit("/", 1)[-1].lower()
    for name in names:
        candidate = name.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if candidate == wanted:
            return name
    return None
