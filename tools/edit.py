"""Edit tool — edit_image.json workflow.

Edits or restores a source image (previous filename or external URL):
injects the image source (LoadImageByUrlOrPath), the edit/restoration prompt,
the seed, steps and LoRAs into the workflow, then submits via ComfyClient
and returns the output image URL.

Restore mode appends the restoration LoRA (Flux2-Klein-Image-RestoreV1) and
uses the restoration prompt prefix — mirroring edit_image/tool.py.
"""

from __future__ import annotations

import json
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common
from tools._common import WorkflowError

WORKFLOW_FILE = "workflows/edit_image.json"

_RESTORE_LORA_NAME = "Flux2-Klein-Image-RestoreV1.safetensors"
_RESTORE_PROMPT_PREFIX = (
    "restore the image quality, remove any compression artifacts, remove any "
    "haze and soft edges, enrich the original with new intricate detail in "
    "all textures and surfaces creating a professional photorealistic "
    "photograph with natural lighting and skin texture,"
)

MODES = ("edit", "restore")

MIN_STEPS, MAX_STEPS = 1, 15


class EditError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",
        "Prompt",
        "KSampler",
        "Power Lora Loader (rgthree)",
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
    mode: str = "edit",
    prompt: str = "",
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta)."""
    mode = (mode or "edit").strip().lower()
    if mode not in MODES:
        raise EditError(f"Invalid mode {mode!r}; must be 'edit' or 'restore'")
    if not image.strip():
        raise EditError("image must not be empty")
    if steps and not (MIN_STEPS <= steps <= MAX_STEPS):
        raise EditError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {steps}")
    seed_arg = _common.resolve_seed(seed)
    loras = _common.parse_lora_config(lora_config)
    restore = mode == "restore"
    stripped = prompt.strip()

    # Restore mode: append the restoration LoRA after the user's LoRAs, and
    # use the restoration prompt prefix (+ user prompt when provided).
    if restore:
        loras = list(loras) + [{"name": _RESTORE_LORA_NAME, "strength": 1.0}]
    if restore:
        value = _RESTORE_PROMPT_PREFIX
        if stripped:
            value += " " + stripped
    else:
        value = prompt

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    # Source image
    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)

    # Prompt
    nodes["Prompt"]["inputs"]["value"] = value

    # Seed + steps (KSampler)
    nodes["KSampler"]["inputs"]["seed"] = seed_arg
    if steps:
        nodes["KSampler"]["inputs"]["steps"] = steps

    # LoRAs
    _common.apply_loras(nodes["Power Lora Loader (rgthree)"]["inputs"], loras)

    meta = {
        "mode": mode,
        "steps": steps,
        "seed": seed_arg,
        "image": image,
        "restore_lora": restore,
    }
    return wf, meta


def edit_image(
    settings: Settings,
    *,
    image: str,
    mode: str = "edit",
    prompt: str = "",
    steps: int = 0,
    seed: int = -1,
    lora_config: str = "[]",
    timeout: float = 120.0,
) -> str:
    """Run the Edit workflow and return the output image URL."""
    workflow = load_workflow()
    wf, meta = build_workflow(
        workflow,
        image=image,
        mode=mode,
        prompt=prompt,
        steps=steps,
        seed=seed,
        lora_config=lora_config,
    )
    with ComfyClient(settings=settings) as client:
        # preview_method: auto — the KSampler decodes its intermediate latent
        # each step and streams JPEG previews over the WS, which server.py's
        # job listener captures for the live preview in the Edit tab (same
        # mechanism as Generate; the flag is per-prompt and auto-reset).
        prompt_id = client.queue_prompt(wf, extra_data={"preview_method": "auto"})
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
