"""Face swap tool — face_swap.json workflow.

Head-swap on a base image (Picture 1) using a face extracted from a second
image (Picture 2 / "Face Reference"): injects BOTH image sources into their
LoadImageByUrlOrPath nodes, plus the steps, CFG (guidance) and seed into the
FLUX.2 sampling stack, then submits via ComfyClient and returns the output
image URL.

The head-swap logic itself (face segmentation → mask enhancement → crop →
alpha → reference latents) is fixed inside the workflow; only the two source
images and the sampling parameters are exposed, plus the dedicated head-swap
LoRA — which, like the restore LoRA in Edit, is injected at runtime instead
of being hardcoded with an OS-specific path. ComfyUI lists subfolder files
(the LoRA lives under ``flux2/``) with the OS separator (``flux2/...`` on
Linux, ``flux2\\...`` on Windows) and the strict ``LoraLoaderModelOnly``
combo only accepts the exact string the server lists, so the tool resolves
the installed name from ``GET /models/loras`` (basename match, see
``_resolve_head_swap_lora``) and sends that verbatim — the same value passes
validation on both OSes. The positive prompt is also fixed in the workflow
(the text input in the UI is disabled — a future version may expose it).
"""

from __future__ import annotations

import json
from typing import Any

from comfy_client import ComfyClient
from config import Settings
from tools import _common
from tools._common import WorkflowError

WORKFLOW_FILE = "workflows/face_swap.json"

# Dedicated head-swap LoRA — bare basename only (no subfolder/OS separators;
# the workflow JSON ships this same neutral value). The tool resolves the
# installed name from the server at runtime and injects it verbatim, mirroring
# _RESTORE_LORA_NAME in tools/edit.py.
_HEAD_SWAP_LORA_NAME = "bfs_head_v1_flux-klein_9b_step3750_rank64.safetensors"

# The workflow's own defaults (mirrors the JSON, used when 0 / not provided).
DEFAULT_STEPS = 6
DEFAULT_CFG = 1.0

# Sampler bounds mirroring the other image tools (edit 1–15); CFG is the
# FLUX.2 guidance value (workflow default 1.0, distilled models use 1).
# CFG steps in 0.1 and may go as low as 0 (no guidance) — 0 is a VALID
# explicit value, so "not provided" is None (keeps the workflow default).
MIN_STEPS, MAX_STEPS = 1, 15
MIN_CFG, MAX_CFG = 0.0, 8.0


class FaceSwapError(ValueError):
    """User-facing parameter validation error."""


def load_workflow() -> dict[str, dict]:
    return _common.load_workflow_json(WORKFLOW_FILE)


def resolve_workflow(workflow: dict[str, dict]) -> dict[str, dict]:
    titles = [
        "Load Image (URL/Path)",   # Picture 1 — base image (kept)
        "Face Reference",          # Picture 2 — face source (extracted)
        "Load LoRA",               # dedicated head-swap LoRA (resolved at runtime)
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
    cfg: float | None = None,
    seed: int = -1,
    lora_name: str | None = None,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta).

    ``lora_name`` is the head-swap LoRA exactly as the ComfyUI server lists
    it (see face_swap_image / _resolve_head_swap_lora); None keeps the
    workflow JSON default.
    """
    if not image.strip():
        raise FaceSwapError("image (base) must not be empty")
    if not face.strip():
        raise FaceSwapError("face image must not be empty")
    if steps and not (MIN_STEPS <= steps <= MAX_STEPS):
        raise FaceSwapError(f"steps must be in [{MIN_STEPS}, {MAX_STEPS}], got {steps}")
    if cfg is not None and not (MIN_CFG <= cfg <= MAX_CFG):
        raise FaceSwapError(f"cfg must be in [{MIN_CFG:g}, {MAX_CFG:g}], got {cfg:g}")
    seed_arg = _common.resolve_seed(seed)

    wf: dict[str, dict] = json.loads(json.dumps(workflow))  # deep copy
    nodes = resolve_workflow(wf)

    # Dedicated head-swap LoRA — the name exactly as the server lists it
    # (OS-native subfolder separators), so the strict LoraLoaderModelOnly
    # combo accepts it on Windows and Linux alike. The workflow JSON default
    # is only the neutral basename; face_swap_image always injects here.
    if lora_name is not None:
        lora_name = lora_name.strip()
        if not lora_name:
            raise FaceSwapError("lora_name must not be empty")
        nodes["Load LoRA"]["inputs"]["lora_name"] = lora_name

    # Picture 1 (base) and Picture 2 (face) — both LoadImageByUrlOrPath
    # nodes, same filename-vs-URL auto-detection as the other tools.
    _common.configure_image_node(nodes["Load Image (URL/Path)"]["inputs"], image)
    _common.configure_image_node(nodes["Face Reference"]["inputs"], face)

    # Steps + CFG + seed (FLUX.2 guidance stack). cfg=None keeps the
    # workflow default (1.0); an explicit 0 is applied as-is (no guidance).
    nodes["Flux2Scheduler"]["inputs"]["steps"] = steps if steps else DEFAULT_STEPS
    if cfg is not None:
        nodes["CFG Guider"]["inputs"]["cfg"] = cfg
    nodes["RandomNoise"]["inputs"]["noise_seed"] = seed_arg

    meta = {
        "steps": steps,
        "cfg": cfg,
        "seed": seed_arg,
        "image": image,
        "face": face,
        "lora_name": lora_name,
    }
    return wf, meta


def _resolve_head_swap_lora(client: ComfyClient) -> str:
    """Name of the head-swap LoRA exactly as the ComfyUI server lists it.

    ComfyUI returns subfolder paths with the OS separator (``flux2/...`` on
    Linux, ``flux2\\...`` on Windows) and the ``LoraLoaderModelOnly`` combo
    only accepts the exact listed string, so the basename is matched against
    ``GET /models/loras`` and the installed name is returned verbatim — the
    same value passes validation regardless of which OS ComfyUI runs on.
    """
    installed = client.list_loras()
    found = _common.match_by_basename(installed, _HEAD_SWAP_LORA_NAME)
    if found is None:
        raise FaceSwapError(
            f"head-swap LoRA {_HEAD_SWAP_LORA_NAME!r} is not installed on the "
            f"ComfyUI server (no match among its {len(installed)} LoRAs)"
        )
    return found


def face_swap_image(
    settings: Settings,
    *,
    image: str,
    face: str,
    steps: int = 0,
    cfg: float | None = None,
    seed: int = -1,
    timeout: float = 240.0,
) -> str:
    """Run the Face swap workflow and return the output image URL."""
    with ComfyClient(settings=settings) as client:
        # The head-swap LoRA path is OS-dependent inside ComfyUI (subfolder
        # separators), so resolve the installed name from the server first
        # and inject it verbatim — never the workflow JSON default.
        lora_name = _resolve_head_swap_lora(client)
        wf, _meta = build_workflow(
            load_workflow(),
            image=image,
            face=face,
            steps=steps,
            cfg=cfg,
            seed=seed,
            lora_name=lora_name,
        )
        # preview_method: auto — the SamplerCustomAdvanced decodes its
        # intermediate latent each step and streams JPEG previews over the
        # WS, which server.py's job listener captures for the live preview
        # in the Face swap tab (same mechanism as Edit/Generate).
        prompt_id = client.queue_prompt(wf, extra_data={"preview_method": "auto"})
        outputs = client.wait_for_output(prompt_id, timeout=timeout)
    image_rec = _common.find_output_image(outputs)
    return client.result_url(image_rec["filename"], image_rec.get("type", "output"))
