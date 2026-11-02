"""Adjust tool — adjust_image.json workflow.

One deterministic ComfyUI node applies brightness, contrast and saturation in
a single pass (``LayerColor: Brightness & Contrast``). No model, sampler,
seed or LoRA is involved. Factors use the node's convention: 1.0 = unchanged,
0.0 = minimum, >1.0 = stronger.
"""

from __future__ import annotations

import json
import math
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common

WORKFLOW_FILE = "workflows/adjust_image.json"

# LayerColor: Brightness & Contrast exposes three 0..3 FLOAT widgets.
MIN_FACTOR = 0.0
MAX_FACTOR = 3.0
NEUTRAL_FACTOR = 1.0


class AdjustError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",
        "Adjust Color",
        "Random Preview Image",
    ]
    resolved: dict[str, dict] = {}
    for t in titles:
        _, node = _common.resolve_node(workflow, t)
        resolved[t] = node
    return resolved


def _factor(name: str, value: Any) -> float:
    """Validate one 0..3 factor (booleans, NaN and infinity are rejected)."""
    if isinstance(value, bool):
        raise AdjustError(f"{name} must be a number")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise AdjustError(f"{name} must be a number")
    if not math.isfinite(parsed):
        raise AdjustError(f"{name} must be a finite number")
    if not (MIN_FACTOR <= parsed <= MAX_FACTOR):
        raise AdjustError(
            f"{name} must be in [{MIN_FACTOR}, {MAX_FACTOR}], got {parsed}"
        )
    return parsed


def build_workflow(
    workflow: dict[str, dict],
    *,
    image: str,
    brightness: Any = NEUTRAL_FACTOR,
    contrast: Any = NEUTRAL_FACTOR,
    saturation: Any = NEUTRAL_FACTOR,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    if not image.strip():
        raise AdjustError("image must not be empty")

    factors = {
        "brightness": _factor("brightness", brightness),
        "contrast": _factor("contrast", contrast),
        "saturation": _factor("saturation", saturation),
    }

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)
    nodes["Adjust Color"]["inputs"].update(factors)

    meta = {"image": image, **factors}
    return wf, meta


def adjust_image(
    settings: Settings,
    *,
    image: str,
    brightness: Any = NEUTRAL_FACTOR,
    contrast: Any = NEUTRAL_FACTOR,
    saturation: Any = NEUTRAL_FACTOR,
    timeout: float = 120.0,
) -> str:
    """Run the Adjust workflow and return the output image URL."""
    workflow = load_workflow()
    wf, _meta = build_workflow(
        workflow,
        image=image,
        brightness=brightness,
        contrast=contrast,
        saturation=saturation,
    )
    with ComfyClient(settings=settings) as client:
        prompt_id = client.queue_prompt(wf)
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
