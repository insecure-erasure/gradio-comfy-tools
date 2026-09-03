"""Face swap tool — face_swap.json workflow.

Head-swap on a base image (Picture 1) using a face extracted from a second
image (Picture 2 / "Face Reference"): injects BOTH image sources into their
LoadImageByUrlOrPath nodes, plus the steps, CFG (guidance) and seed into the
FLUX.2 sampling stack, then submits via ComfyClient and returns the output
image URL.

The head-swap logic itself (face segmentation → mask enhancement → crop →
alpha → reference latents) is fixed inside the workflow; only the two source
images, the sampling parameters and an OPTIONAL extra prompt are exposed,
plus the dedicated head-swap LoRA — which, like the restore LoRA in Edit,
is injected at runtime instead of being hardcoded with an OS-specific path.
ComfyUI lists subfolder files (the LoRA lives under ``flux2/``) with the OS
separator (``flux2/...`` on Linux, ``flux2\\...`` on Windows) and the strict
``LoraLoaderModelOnly`` combo only accepts the exact string the server
lists, so the tool resolves the installed name from ``GET /models/loras``
(basename match, see ``_resolve_head_swap_lora``) and sends that verbatim —
the same value passes validation on both OSes.

The positive prompt is built in the workflow by a StringConcatenate node
(``Concat Prompt (Positive)``): the built-in head_swap instructions are its
fixed first part, and the OPTIONAL user prompt (the ``Prompt``
PrimitiveStringMultiline node — the text input in the UI) is appended after
it, verbatim. An empty extra prompt leaves the built-in instructions
unchanged.

The workflow ends in TWO output preview nodes: the swapped result (``Random
Preview Image``) and the extracted-face preview (``Random Preview Image
(face)``, fed by the face-crop node). face_swap_image waits for the MAIN
output (the face crop is recorded earlier) and returns both URLs, so the
frontend can show the extracted face in its own overlay box.
"""

from __future__ import annotations

import json
import random
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

# The workflow's TWO output preview nodes (RandomPreviewImage): the main
# result and the extracted-face preview, which is fed by the face-crop node
# and can be recorded by ComfyUI BEFORE the sampled result. History outputs
# are keyed by node id, so resolution goes through the titles of the
# SUBMITTED workflow (see select_result_images).
MAIN_OUTPUT_TITLE = "Random Preview Image"
FACE_OUTPUT_TITLE = "Random Preview Image (face)"

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
        "Prompt",                  # extra prompt, appended after the built-in one
        "Concat Prompt (Positive)",  # built-in head_swap text + extra prompt
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
    prompt: str = "",
    steps: int = 0,
    cfg: float | None = None,
    seed: int = -1,
    lora_name: str | None = None,
) -> tuple[dict[str, dict], dict[str, Any]]:
    """Inject parameters into a copy of the workflow. Returns (workflow, meta).

    ``prompt`` is an OPTIONAL extra prompt: the workflow concatenates it
    AFTER its built-in head_swap instructions (the ``Prompt`` node feeds a
    StringConcatenate whose first part is the fixed text), so an empty
    prompt runs the built-in instructions unchanged.
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

    # Cache bust for the FACE chain (extraction + its preview node): ComfyUI
    # caches node outputs across prompts — with the same face image the
    # chain would NOT re-execute and would emit no 'executed' WS event, so
    # the backend could not push the extracted-face preview mid-run (the
    # whole point of the second output node). ComfyUI ignores undeclared
    # input keys at execution, but they still vary the node's cache key, so
    # a harmless per-run value forces the extraction to run (and its
    # preview node to fire) on every job.
    nodes["Face Reference"]["inputs"]["cache_bust"] = str(random.randint(0, 2**32))

    # Steps + CFG + seed (FLUX.2 guidance stack). cfg=None keeps the
    # workflow default (1.0); an explicit 0 is applied as-is (no guidance).
    nodes["Flux2Scheduler"]["inputs"]["steps"] = steps if steps else DEFAULT_STEPS
    if cfg is not None:
        nodes["CFG Guider"]["inputs"]["cfg"] = cfg
    nodes["RandomNoise"]["inputs"]["noise_seed"] = seed_arg

    # Optional extra prompt — the concat node appends it AFTER the built-in
    # head_swap text (the ``Prompt`` PrimitiveStringMultiline feeds the
    # StringConcatenate's string_b; empty = built-in prompt unchanged).
    nodes["Prompt"]["inputs"]["value"] = prompt

    meta = {
        "steps": steps,
        "cfg": cfg,
        "seed": seed_arg,
        "image": image,
        "face": face,
        "prompt": prompt,
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


def node_id_titles(workflow: dict[str, dict]) -> dict[str, str]:
    """node_id -> _meta.title (fallback class_type) of a workflow."""
    return {
        str(nid): (node.get("_meta", {}).get("title") or node.get("class_type") or str(nid))
        for nid, node in workflow.items()
    }


def select_result_images(
    outputs: dict[str, Any], titles: dict[str, str]
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """(main, face) image records from a ComfyUI history outputs dict.

    The face-swap workflow has TWO RandomPreviewImage outputs — the main
    result and the extracted-face preview, which can be recorded BEFORE the
    sampled result (the crop runs early). History keys outputs by node id, so
    the ids are mapped through ``titles`` (node id -> title, from the
    workflow that was actually submitted). Any image whose node is not tagged
    as the face output counts as the main result; each missing output is
    None.
    """
    main: dict[str, Any] | None = None
    face: dict[str, Any] | None = None
    for nid, node_out in outputs.items():
        images = node_out.get("images") or []
        if not images:
            continue
        if titles.get(str(nid)) == FACE_OUTPUT_TITLE:
            if face is None:
                face = images[0]
        elif main is None:
            main = images[0]
    return main, face


def face_swap_image(
    settings: Settings,
    *,
    image: str,
    face: str,
    prompt: str = "",
    steps: int = 0,
    cfg: float | None = None,
    seed: int = -1,
    timeout: float = 240.0,
) -> tuple[str, str | None]:
    """Run the Face swap workflow and return the output image URL(s).

    Returns ``(url, face_preview_url)``: the swapped image plus the
    extracted-face preview (the workflow's second RandomPreviewImage
    output), or None for the preview when it is absent.
    """
    with ComfyClient(settings=settings) as client:
        # The head-swap LoRA path is OS-dependent inside ComfyUI (subfolder
        # separators), so resolve the installed name from the server first
        # and inject it verbatim — never the workflow JSON default.
        lora_name = _resolve_head_swap_lora(client)
        wf, _meta = build_workflow(
            load_workflow(),
            image=image,
            face=face,
            prompt=prompt,
            steps=steps,
            cfg=cfg,
            seed=seed,
            lora_name=lora_name,
        )
        titles = node_id_titles(wf)

        # The face-preview output can finish before the sampled result, so
        # wait until the MAIN output exists (when the workflow has the face
        # node; without it any output is the result — legacy behavior).
        def _main_done(outputs: dict[str, Any]) -> bool:
            main, _ = select_result_images(outputs, titles)
            return main is not None or FACE_OUTPUT_TITLE not in titles.values()

        # preview_method: auto — the SamplerCustomAdvanced decodes its
        # intermediate latent each step and streams JPEG previews over the
        # WS, which server.py's job listener captures for the live preview
        # in the Face swap tab (same mechanism as Edit/Generate).
        prompt_id = client.queue_prompt(wf, extra_data={"preview_method": "auto"})
        outputs = client.wait_for_output(prompt_id, timeout=timeout, until=_main_done)
    main_rec, face_rec = select_result_images(outputs, titles)
    if main_rec is None:
        main_rec = _common.find_output_image(outputs)  # raises when empty
    url = client.result_url(main_rec["filename"], main_rec.get("type", "output"))
    face_url = (
        client.result_url(face_rec["filename"], face_rec.get("type", "output"))
        if face_rec is not None
        else None
    )
    return url, face_url
