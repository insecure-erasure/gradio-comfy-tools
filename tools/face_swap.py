"""Face swap tool — face_swap.json workflow.

Head-swap on a base image (Picture 1) using a face extracted from a second
image (Picture 2 / "Face Reference"): injects BOTH image sources into their
LoadImageByUrlOrPath nodes, plus the steps, CFG (guidance) and seed into the
FLUX.2 sampling stack, then submits via ComfyClient and returns the output
image URL.

The head-swap logic itself (face segmentation → mask enhancement → crop →
alpha → reference latents, driven by the dedicated head-swap LoRA
`flux2/bfs_head_v1_flux-klein_9b_step3750_rank64`) is fixed inside the
workflow; only the two source images and the sampling parameters are
exposed. The positive prompt is also fixed in the workflow (the text input
in the UI is disabled — a future version may expose it).
"""

from __future__ import annotations

import json
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common
from tools._common import WorkflowError

WORKFLOW_FILE = "workflows/face_swap.json"

# The workflow's own defaults (mirrors the JSON, used when 0 / not provided).
DEFAULT_STEPS = 6
DEFAULT_CFG = 1.0

# Sampler bounds mirroring the other image tools (edit 1–15); CFG is the
# FLUX.2 guidance value (workflow default 1.0, distilled models use 1).
MIN_STEPS, MAX_STEPS = 1, 15
MIN_CFG, MAX_CFG = 0.5, 8.0


class FaceSwapError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",   # Picture 1 — base image (kept)
        "Face Reference",          # Picture 2 — face source (extracted)
        "Flux2Scheduler",          # steps
        "CFG Guider",              # cfg (guidance)
        "RandomNoise",             # seed
        "Random Preview Image",    # output
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
    face: str,
    steps: int = 0,
    cfg: float = 0.0,
    seed: int = -1,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    if not image.strip():
        raise FaceSwapError("image (base) must not be empty")
    if not face.strip():
        raise FaceSwapError("face image must not be empty")
    if steps and not (MIN_STEPS <= steps <= MAX_STEPS):
        raise FaceSwapError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {steps}")
    if cfg and not (MIN_CFG <= cfg <= MAX_CFG):
        raise FaceSwapError(f"cfg must be in [{MIN_CFG:g}, {MAX_CFG:g}], got {cfg:g}")
    seed_arg = _common.resolve_seed(seed)

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    # Picture 1 (base) and Picture 2 (face) — both LoadImageByUrlOrPath
    # nodes, same filename-vs-URL auto-detection as the other tools.
    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)
    _common.configure_image_node(nodes["Face Reference"]["inputs"], face)

    # Steps + CFG + seed (FLUX.2 guidance stack).
    nodes["Flux2Scheduler"]["inputs"]["steps"] = steps if steps else DEFAULT_STEPS
    nodes["CFG Guider"]["inputs"]["cfg"] = cfg if cfg else DEFAULT_CFG
    nodes["RandomNoise"]["inputs"]["noise_seed"] = seed_arg

    meta = {
        "steps": steps,
        "cfg": cfg,
        "seed": seed_arg,
        "image": image,
        "face": face,
    }
    return wf, meta


def face_swap_image(
    settings: Settings,
    *,
    image: str,
    face: str,
    steps: int = 0,
    cfg: float = 0.0,
    seed: int = -1,
    timeout: float = 240.0,
) -> str:
    """Run the Face swap workflow and return the output image URL."""
    workflow = load_workflow()
    wf, _meta = build_workflow(
        workflow,
        image=image,
        face=face,
        steps=steps,
        cfg=cfg,
        seed=seed,
    )
    with ComfyClient(settings=settings) as client:
        # preview_method: auto — the SamplerCustomAdvanced decodes its
        # intermediate latent each step and streams JPEG previews over the
        # WS, which server.py's job listener captures for the live preview
        # in the Face swap tab (same mechanism as Edit/Generate).
        prompt_id = client.queue_prompt(wf, extra_data={"preview_method": "auto"})
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
