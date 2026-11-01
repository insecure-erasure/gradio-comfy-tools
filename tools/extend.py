"""Extend tool — extend_image.json workflow.

Extends an image on any of its four sides (outpainting) and returns the
resulting image URL. The workflow paints the new area green, asks FLUX.2 to
remove it, and (when the source is larger than 1 MP) restores the source's
pixel density on the extended canvas.

Parameters are injected into the workflow by node title, mirroring the Edit
tool: source image, padding, feathering, optional extra prompt, steps, seed,
ColorMatch strength and LoRAs.
"""

from __future__ import annotations

import json
import re
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common

WORKFLOW_FILE = "workflows/extend_image.json"

# The workflow already contains this instruction; the user's optional prompt
# is appended after it.
BASE_PROMPT = "remove the green part"

MIN_PAD, MAX_PAD = 0, 1024
MIN_FEATHERING, MAX_FEATHERING = 0, 256
DEFAULT_FEATHERING = 40
MIN_STEPS, MAX_STEPS = 1, 15
# ColorMatch node already present in extend_image.json (strength 1.0 by
# default). The UI can lower it; API clients that omit color_match keep the
# workflow default.
MIN_COLOR_MATCH, MAX_COLOR_MATCH = 0.0, 1.0

_INT_RE = re.compile(r"[+-]?\d+")


class ExtendError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",
        "Pad Image for Outpainting",
        "Prompt",
        "RandomNoise",
        "Flux2Scheduler",
        "Power Lora Loader (rgthree)",
        "Color Match",
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
        raise ExtendError(f"{name} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not value.is_integer():
            raise ExtendError(f"{name} must be an integer")
        return int(value)
    if isinstance(value, str):
        raw = value.strip()
        if not _INT_RE.fullmatch(raw):
            raise ExtendError(f"{name} must be an integer")
        return int(raw)
    raise ExtendError(f"{name} must be an integer")


def _bounded_integer(name: str, value: Any, minimum: int, maximum: int) -> int:
    parsed = _integer(name, value)
    if not (minimum <= parsed <= maximum):
        raise ExtendError(f"{name} must be in [{minimum}, {maximum}], got {parsed}")
    return parsed


def _color_match_strength(value: Any) -> float | None:
    """Validate the optional ColorMatch strength (0..1); None = keep default."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ExtendError("color_match must be a number")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ExtendError("color_match must be a number")
    if not (MIN_COLOR_MATCH <= parsed <= MAX_COLOR_MATCH):
        raise ExtendError(
            f"color_match must be in [{MIN_COLOR_MATCH}, {MAX_COLOR_MATCH}], got {value}"
        )
    return parsed


def build_workflow(
    workflow: dict[str, dict],
    *,
    image: str,
    left: Any = 0,
    top: Any = 0,
    right: Any = 0,
    bottom: Any = 0,
    feathering: Any = DEFAULT_FEATHERING,
    prompt: str = "",
    steps: Any = 0,
    seed: int = -1,
    lora_config: str = "[]",
    color_match: float | None = None,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    if not image.strip():
        raise ExtendError("image must not be empty")

    pads = {
        "left": _bounded_integer("left", left, MIN_PAD, MAX_PAD),
        "top": _bounded_integer("top", top, MIN_PAD, MAX_PAD),
        "right": _bounded_integer("right", right, MIN_PAD, MAX_PAD),
        "bottom": _bounded_integer("bottom", bottom, MIN_PAD, MAX_PAD),
    }
    if not any(pads.values()):
        raise ExtendError("at least one edge must be greater than 0")

    feathering = _bounded_integer(
        "feathering", feathering, MIN_FEATHERING, MAX_FEATHERING
    )
    steps = _integer("steps", steps)
    if steps and not (MIN_STEPS <= steps <= MAX_STEPS):
        raise ExtendError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {steps}")

    seed_arg = _common.resolve_seed(seed, max_value=_common.UINT64_SEED_MAX)
    loras = _common.parse_lora_config(lora_config)
    color_match = _color_match_strength(color_match)

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    # Source image
    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)

    # Padding + feathering
    pad_inputs = nodes["Pad Image for Outpainting"]["inputs"]
    pad_inputs.update(pads)
    pad_inputs["feathering"] = feathering

    # Keep the built-in green-removal instruction and append the optional
    # user prompt after it (the node's delimiter is ". ").
    nodes["Prompt"]["inputs"]["string_a"] = BASE_PROMPT
    nodes["Prompt"]["inputs"]["string_b"] = prompt.strip()

    # Seed + steps (FLUX.2 guidance stack: RandomNoise + Flux2Scheduler)
    nodes["RandomNoise"]["inputs"]["noise_seed"] = seed_arg
    if steps:
        nodes["Flux2Scheduler"]["inputs"]["steps"] = steps

    # LoRAs
    _common.apply_loras(nodes["Power Lora Loader (rgthree)"]["inputs"], loras)

    # Optional ColorMatch strength (workflow default 1.0).
    if color_match is not None:
        nodes["Color Match"]["inputs"]["strength"] = color_match

    meta = {
        "image": image,
        "left": pads["left"],
        "top": pads["top"],
        "right": pads["right"],
        "bottom": pads["bottom"],
        "feathering": feathering,
        "prompt": prompt.strip(),
        "steps": steps,
        "seed": seed_arg,
        "color_match": color_match,
    }
    return wf, meta


def extend_image(
    settings: Settings,
    *,
    image: str,
    left: Any = 0,
    top: Any = 0,
    right: Any = 0,
    bottom: Any = 0,
    feathering: Any = DEFAULT_FEATHERING,
    prompt: str = "",
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    color_match: float | None = None,
    timeout: float = 180.0,
) -> str:
    """Run the Extend workflow and return the output image URL."""
    workflow = load_workflow()
    wf, _meta = build_workflow(
        workflow,
        image=image,
        left=left,
        top=top,
        right=right,
        bottom=bottom,
        feathering=feathering,
        prompt=prompt,
        steps=steps,
        seed=seed,
        lora_config=lora_config,
        color_match=color_match,
    )
    with ComfyClient(settings=settings) as client:
        # Same live per-step previews as Edit/Generate.
        prompt_id = client.queue_prompt(wf, extra_data={"preview_method": "auto"})
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
