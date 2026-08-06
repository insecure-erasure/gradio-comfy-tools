"""Upscale tool — seedvr2_upscale.json workflow.

Upscales a source image (previous filename or external URL) with SeedVR2.
Only ``image`` + ``seed`` are exposed; resolution (2048), color correction
(lab) and blend factor (0.15) stay fixed in the workflow (decided).

Mirrors upscale_image/tool.py.
"""

from __future__ import annotations

import json
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common
from tools._common import WorkflowError

WORKFLOW_FILE = "workflows/seedvr2_upscale.json"


class UpscaleError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",
        "SeedVR2 Video Upscaler (v2.5.24)",
        "Random Preview Image",
    ]
    resolved: dict[str, dict] = {}
    for t in titles:
        _, node = _common.resolve_node(workflow, t)
        resolved[t] = node
    return resolved


def build_workflow(
    workflow: dict[str, dict],
    *,
    image: str,
    seed: int = -1,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    if not image.strip():
        raise UpscaleError("image must not be empty")
    seed_arg = _common.resolve_seed(seed)

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)
    nodes["SeedVR2 Video Upscaler (v2.5.24)"]["inputs"]["seed"] = seed_arg

    meta = {"seed": seed_arg, "image": image}
    return wf, meta


def upscale_image(
    settings: Settings,
    *,
    image: str,
    seed: int = -1,
    timeout: float = 120.0,
) -> str:
    """Run the Upscale workflow and return the output image URL."""
    workflow = load_workflow()
    wf, meta = build_workflow(workflow, image=image, seed=seed)
    with ComfyClient(settings=settings) as client:
        prompt_id = client.queue_prompt(wf)
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
