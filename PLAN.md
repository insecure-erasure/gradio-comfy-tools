# PLAN — gradio-comfy-tools

Phase-based implementation of the project (spec in `FRONTEND.md` / `BACKEND.md`,
UI in `mockup.html`, workflows in `workflows/`). The plan has **two parts**:

- **Part A — Backend** (this document, §A0–A6): ComfyUI infrastructure + one
  tool per tab. Each tab is **manually validated** against the server (default
  `http://192.168.1.8`) before moving to the next one.
- **Part B — Frontend** (pending): the Gradio app (`app.py`) that consumes the
  tools. It will be written once Part A is done, reusing its contract.

Every Part A phase ends with a **Manual validation** block: concrete steps and
expected result. Do not move to the next phase until the user validates it.

---

# Part A — Backend

## A0. Foundations (shared infrastructure)

### Goal
Reusable base for all 4 tabs: ComfyUI REST client, configuration and workflow
injection helpers. Delivered with tests and a real smoke test against the server.

### Files
| File | Contents |
|---|---|
| `config.py` | `Settings`: `comfyui_base_url` (default `http://192.168.1.8`), `comfyui_media_base_url` (derived from base), `api_key` (optional). Loaded from env + runtime override (for the 🎨 settings). |
| `comfy_client.py` | **Sync** REST client (`httpx.Client`), no Gradio dependency. |
| `tools/_common.py` | `resolve_node(workflow, title)` (by unique `_meta.title`), injection helpers (seed, steps, lora_config, frames snap), filename-vs-URL auto-detection. |
| `tests/test_comfy_client.py` | Tests with `httpx.MockTransport` (no server needed). |
| `scripts/smoke_client.py` | Real smoke test: health → upload → queue a trivial workflow → poll → URL. |

### REST contract (validated against ComfyUI 0.29.1 on 192.168.1.8)
| Method/endpoint | Use | Response |
|---|---|---|
| `GET /system_stats` | health | JSON with `system.comfyui_version` |
| `POST /upload/image` | upload local file (multipart) → `type=temp` | `{"name": "<filename>", ...}` |
| `POST /prompt` | queue workflow `{"prompt": {...}, "client_id": "<uuid>"}` | `{"prompt_id": "<id>"}` |
| `GET /history/{prompt_id}` | poll until `outputs` is non-empty (1s, configurable timeout, default 120s) | prompt outputs |
| `GET {media_base}/view?filename=...&type=output` | public result URL | — |

Decisions: **sync** (Gradio runs handlers in threads; the reference is async
because Open WebUI requires it, not needed here) and **history polling** (same
as the reference, no websocket dependency).

### Manual validation (A0)
```
python3 scripts/smoke_client.py            # uses COMFYUI_BASE_URL or the default
```
Expected: `health OK (ComfyUI 0.29.1)` → uploads a test image → queues a minimal
workflow → prints the `/view?...` URL. The user opens the URL in the browser and
sees the result.

---

## A1. Generate tab 🖼️ — `smart_generate_image.json`

### Goal
`tools/generate.py`: runs the Generate workflow — model family (Z-Image Turbo,
Krea 2, FLUX.2 Klein), prompt, resolution (AR + MP), steps, seed and LoRAs. It
is the first tab because it defines the patterns the others reuse (resolution,
seed, LoRA).

### Input contract
| Parameter | Type / default | Rules |
|---|---|---|
| `family` | select: `zimage` / `krea2` / `flux2` (default `zimage`) | selects `MODEL_CONFIGS` (model, clip, vae, vae_scale, cfg, steps, sampler, scheduler) |
| `prompt` | str, default "" | required in practice (validated non-empty) |
| `aspect_ratio` | str "W:H" | normalized by GCD; default 2:3 |
| `megapixel` | float, default 1.0 | controls total resolution (independent of AR) |
| `steps` | int, default: from family (0 = default) | 1–15 |
| `seed` | int, default -1 | -1 = random |
| `lora_config` | JSON array (optional) | slots `lora_1..lora_4` of the Power Lora Loader |

### Per-node injections (workflow titles)
| Node (`_meta.title`) | What is written |
|---|---|
| `Load Diffusion Model` (UNETLoader) | `unet_name` per family |
| `Load CLIP` (CLIPLoader) | `clip_name` per family |
| `Load VAE` (VAELoader) | `vae_name` per family |
| `Prompt` (PrimitiveStringMultiline) | `value` = prompt |
| `Flux Resolution Calc` | `megapixel`, `divisible_by` = `vae_scale_factor` (16/8/64) |
| `Aspect ratio` (StringConcatenate) | `string_a`/`string_b` = reduced W:H (GCD + MP) |
| `Steps` (easy int) | `value` = steps |
| `RandomNoise` / `KSamplerSelect` | `noise_seed` / sampler per family |
| `Power Lora Loader (rgthree)` | activates `lora_1..4` from `lora_config` |

### Manual validation (A1)
CLI `scripts/run_generate.py --family zimage|krea2|flux2 --prompt "..." [--ar 16:9] [--mp 1.0] [--steps 8] [--seed -1]`.
Steps: generate with **each family**, with AR 2:3 and 16:9, with a fixed seed
(repeat → same image) and with a real LoRA from the server (e.g.
`flux2/Flux2-Klein-Image-RestoreV1.safetensors` on flux2).
Expected: `/view?filename=ComfyUI_...png&type=output` URL with the correct image.

---

## A2. Edit tab ✏️ — `edit_image.json`

### Goal
`tools/edit.py`: edit/restore a source image (previous filename or external
URL), with prompt, steps, seed and LoRAs.

### Input contract
| Parameter | Type / default | Rules |
|---|---|---|
| `image` | str (filename or URL) | auto-detection: `urlparse` with scheme+netloc → `source="url"`; otherwise → `source="temp"` (filename) |
| `mode` | `"edit"` / `"restore"` | restore: adds LoRA `flux2/Flux2-Klein-Image-RestoreV1.safetensors` + restoration prompt prefix |
| `prompt` | str, default "" | optional in restore |
| `steps` | int, default 6 | 1–15 |
| `seed` | int, default -1 | -1 = random |
| `lora_config` | JSON array (optional) | Power Lora Loader slots |

### Injections
| Node | What is written |
|---|---|
| `Load Image (URL/Path)` | `source` + `url` / `image` (per detection); clears `Choose file to upload` |
| `Prompt` | `value` = prompt (in restore, prefix + prompt) |
| `KSampler` | `steps`, `seed` |
| `Power Lora Loader (rgthree)` | adds restore LoRA + `lora_config` |

### Manual validation (A2)
CLI `scripts/run_edit.py --image <filename|URL> --mode edit|restore [--prompt "..."] [--steps 6] [--seed -1]`.
Steps: edit an uploaded image (temp filename), edit an image from an external
URL, and restore mode. Expected: edited image with correct output URL.

---

## A3. Upscale tab 🔍 — `seedvr2_upscale.json`

### Goal
`tools/upscale.py`: 2x upscale of a source image. **No** extra parameters
(resolution 2048, `color_correction` lab, `blend_factor` 0.15 fixed in the
workflow — decided).

### Input contract
| Parameter | Type / default | Rules |
|---|---|---|
| `image` | str (filename or URL) | auto-detection same as Edit |
| `seed` | int, default -1 | -1 = random |

### Injections
| Node | What is written |
|---|---|
| `Load Image (URL/Path)` | `source` + `url` / `image` |
| `SeedVR2 Video Upscaler` | `seed` |

### Manual validation (A3)
CLI `scripts/run_upscale.py --image <filename|URL> [--seed -1]`.
Steps: upscale an uploaded image and an external URL (2x). Expected: upscaled
image (2048 on the long side) with correct output URL.

---

## A4. Video tab 🎬 — `generate_video.json` / `generate_video_wan22.json`

### Goal
`tools/video.py`: image → video with Wan 2.1 (single path) or Wan 2.2 (dual
high/low path), 4n+1 frames, steps, seed, prompt and negative.

### Input contract
| Parameter | Type / default | Rules |
|---|---|---|
| `image` | str (filename or URL) | auto-detection same as Edit |
| `model_version` | `"wan21"` / `"wan22"` | selects workflow + video `MODEL_CONFIGS` |
| `prompt` | str | — |
| `negative_prompt` | str, default "" | empty → workflow default |
| `frames` | int, default 81 | snap to nearest 4n+1: `snapped=((n-1)//4)*4+1; +=4 if n-snapped>2`; clamp [81,161] |
| `steps` | int, default 4 | 4–10; wan22: odd → even (rounded up) |
| `seed` | int, default -1 | -1 = random |

### Injections
| Node | What is written |
|---|---|
| `Load Image (URL/Path)` | `source` + `url` / `image` |
| `Load Diffusion Model` (×2 in wan22) | `unet_name` high/low per family |
| `WanImageToVideo` | `length` (frames), `start_image` (connected to Load Image) |
| `KSamplerAdvanced` / `KSampler` | `steps`, `seed` (wan22: dual high/low path) |
| `CLIP Text Encode (Prompt)` / `(Negative)` | prompt / negative |
| `Frame Interpolate` | model `rife_v4.26` (already in the workflow) |

### Manual validation (A4)
CLI `scripts/run_video.py --image <filename|URL> --model wan21|wan22 [--frames 81] [--steps 4] [--seed -1] [--prompt "..."]`.
Steps: short wan21 and wan22 videos (81 frames), with frames 100 (verify snap →
101) and odd steps on wan22 (verify → even). Expected: `.mp4` with output URL.

---

## A5. Chaining + global configuration (backend)

### Goal
Expose what the frontend needs for 🔗/📋 and 🎨 without UI logic.

### Contents
- `result_url(filename, type="output")` → `{media_base}/view?filename=...&type=output`
  (used by all 4 tools; the reference uses `/api/view`, we use `/view` unless
  validation says otherwise).
- `normalize_source(image)` → `(filename | url, kind)` — the centralized
  filename-vs-URL auto-detection (shared by Edit/Upscale/Video).
- `Settings` runtime: `set_base_url / set_media_base_url / set_api_key` for the
  🎨; persisted in a user config file (`.gradio-comfy-tools.json`) or env,
  decision at implementation time.
- `last_generated` per session: handled by the frontend (Gradio state); the
  backend only exposes `result_url` and the naming convention.

Status: **implemented** — `result_url` (ComfyClient), `normalize_source`
(tools/_common), runtime settings setters (config.py), and the full-chain
script `scripts/run_chain.py`; manual validation passed (A→B→C→D filenames).

### Manual validation (A5)
Script `scripts/run_chain.py`: generate → edit the result (filename) → upscale
that result → video from that result. Expected: the whole chain works passing
**filenames** (not URLs) between steps.

---

## A6. Acceptance criteria (complete backend)

1. `python3 scripts/check_env.py` → TODO OK (nodes + models against the server).
2. `pytest` green (MockTransport tests for `comfy_client` and helpers).
3. Smoke + CLI of the 4 tabs manually validated (A1–A4).
4. Full chain A5 validated.
5. All of BACKEND.md §5–§6 implemented and verified.

---

# Part B — Frontend (pending)

> Will be written once Part A is validated. Planned structure:

- B0. `app.py` Gradio `gr.Blocks` + `queue()` — per-tab layout per FRONTEND.md,
  connecting components to the Part A tools.
- B1. Generate in the UI (first real end-to-end wiring).
- B2. Edit / Upscale / Video in the UI (compare slider, mock player, URL field,
  🔗/📁).
- B3. Results: result + 📋 copy, 🔗 chaining, cleared on tab switch.
- B4. 🎨 settings + advanced modal (LoRA config JSON) + toasts + responsive.

Each phase will include its **Manual validation** in the UI (the user tests the
tab in the browser against the real backend).
