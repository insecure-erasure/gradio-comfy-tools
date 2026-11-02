"""Crop tool — crop_image.json workflow.

A deterministic pixel operation: load the source image, crop the requested
rectangle and save the result through the same output node as the other
tools, so the rest of the app (media proxy, gallery, source history) works
unchanged. No model, sampler, seed or LoRA is involved.
"""

from __future__ import annotations

import json
import re
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common

WORKFLOW_FILE = "workflows/crop_image.json"

# ImageCrop's INT widgets use ComfyUI's MAX_RESOLUTION.
MIN_COORD = 0
MAX_COORD = 16384
MIN_SIZE = 1
MAX_SIZE = 16384

_INT_RE = re.compile(r"[+-]?\d+")


class CropError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",
        "Crop Image",
        "Random Preview Image",
    ]
    resolved: dict[str, dict] = {}
    for t in titles:
        _, node = _common.resolve_node(workflow, t)
        resolved[t] = node
    return resolved


def _integer(name: str, value: Any) -> int:
    """Validate a whole-number workflow parameter (booleans are rejected)."""
    if isinstance(value, bool):
        raise CropError(f"{name} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not value.is_integer():
            raise CropError(f"{name} must be an integer")
        return int(value)
    if isinstance(value, str):
        raw = value.strip()
        if not _INT_RE.fullmatch(raw):
            raise CropError(f"{name} must be an integer")
        return int(raw)
    raise CropError(f"{name} must be an integer")


def _bounded_integer(name: str, value: Any, minimum: int, maximum: int) -> int:
    parsed = _integer(name, value)
    if not (minimum <= parsed <= maximum):
        raise CropError(f"{name} must be in [{minimum}, {maximum}], got {parsed}")
    return parsed


def build_workflow(
    workflow: dict[str, dict],
    *,
    image: str,
    width: Any,
    height: Any,
    x: Any = 0,
    y: Any = 0,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    if not image.strip():
        raise CropError("image must not be empty")

    crop = {
        "x": _bounded_integer("x", x, MIN_COORD, MAX_COORD),
        "y": _bounded_integer("y", y, MIN_COORD, MAX_COORD),
        "width": _bounded_integer("width", width, MIN_SIZE, MAX_SIZE),
        "height": _bounded_integer("height", height, MIN_SIZE, MAX_SIZE),
    }

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)
    nodes["Crop Image"]["inputs"].update(crop)

    meta = {"image": image, **crop}
    return wf, meta


def crop_image(
    settings: Settings,
    *,
    image: str,
    width: Any,
    height: Any,
    x: Any = 0,
    y: Any = 0,
    timeout: float = 60.0,
) -> str:
    """Run the Crop workflow and return the output image URL."""
    workflow = load_workflow()
    wf, _meta = build_workflow(
        workflow,
        image=image,
        width=width,
        height=height,
        x=x,
        y=y,
    )
    with ComfyClient(settings=settings) as client:
        prompt_id = client.queue_prompt(wf)
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
