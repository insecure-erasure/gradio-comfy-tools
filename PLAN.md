# PLAN — gradio-comfy-tools

Phase-based implementation of the project (spec in `FRONTEND.md` / `BACKEND.md`,
UI in `mockup.html`, workflows in `workflows/`). The plan has **two parts**:

- **Part A — Backend** (this document, §A0–A6): ComfyUI infrastructure + one
  tool per tab. **DONE + validated manually.**
- **Part B — Frontend** (§B0–B4): the web UI. **Re-scoped**: FastAPI +
  `app.html` (a working copy of the mockup) instead of Gradio — see §B below.

Every phase ends with a **Manual validation** block: concrete steps and
expected result. Do not move to the next phase until the user validates it.

---

# Part A — Backend ✅ (validated)

| Phase | What | Status |
|---|---|---|
| A0 | Foundations: `config.py`, `comfy_client.py`, `tools/_common.py`, tests (MockTransport), `scripts/smoke_client.py` | ✅ |
| A1 | Generate: `tools/generate.py` + `scripts/run_generate.py` | ✅ |
| A2 | Edit: `tools/edit.py` + `scripts/run_edit.py` | ✅ |
| A3 | Upscale: `tools/upscale.py` + `scripts/run_upscale.py` (seed uint32 fix) | ✅ |
| A4 | Video: `tools/video.py` + `scripts/run_video.py` | ✅ |
| A5 | Chaining: `scripts/run_chain.py` + `normalize_source` | ✅ |
| A6 | Acceptance: `check_env.py` OK, 55 tests green, chains validated | ✅ |

Details of each A-phase remain below as reference (input contracts, per-node
injections, manual validation steps).

---

## A0. Foundations (shared infrastructure)

### Goal
Reusable base for all 4 tabs: ComfyUI REST client, configuration and workflow
injection helpers. Delivered with tests and a real smoke test against the server.

### Files
| File | Contents |
|---|---|
| `config.py` | `Settings`: `comfyui_base_url` (default `http://192.168.1.8`), `comfyui_media_base_url` (derived from base), `api_key` (optional). Loaded from env + runtime override (for the 🎨 settings). |
| `comfy_client.py` | **Sync** REST client (`httpx.Client`), no web-framework dependency. |
| `tools/_common.py` | `resolve_node(workflow, title)` (by unique `_meta.title`), injection helpers (seed, steps, lora_config, frames snap), filename-vs-URL auto-detection, `find_output_image/video`. |
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

Decisions: **sync** (web handlers run in threads) and **history polling** (same
as the reference, no websocket dependency).

### Manual validation (A0) ✅
```
python3 scripts/smoke_client.py            # uses COMFYUI_BASE_URL or the default
```
Expected: `health OK (ComfyUI 0.29.1)` → uploads a test image → queues a minimal
workflow → prints the `/view?...` URL. The user opens the URL in the browser and
sees the result. **Done — violet 64×64 square confirmed.**

---

## A1. Generate tab 🖼️ — `smart_generate_image.json`

### Goal
`tools/generate.py`: runs the Generate workflow — model family (Z-Image Turbo,
Krea 2, FLUX.2 Klein), prompt, resolution (AR + MP), steps, seed and LoRAs.

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

### Manual validation (A1) ✅
CLI `scripts/run_generate.py --family zimage|krea2|flux2 --prompt "..."`.
Done: zimage 2:3 seed42 (816×1216), krea2 16:9 (1336×752), flux2 3:2 (1216×832),
flux2+LoRA restore — all 200 image/png, apple confirmed in browser.

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

### Manual validation (A2) ✅
Done: edit temp filename (green apple), edit via external URL (blue plate),
restore mode — all 200 image/png, 832×1248.

---

## A3. Upscale tab 🔍 — `seedvr2_upscale.json`

### Goal
`tools/upscale.py`: 2x upscale of a source image. **No** extra parameters
(resolution 2048, `color_correction` lab, `blend_factor` 0.15 fixed).

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

### Manual validation (A3) ✅
Done: upscale filename (apple 1374×2048) and external URL (cat 2048×1152) —
both 2048 on the long side. Note: **seed range uint32** (`COMFY_SEED_MAX`),
SeedVR2 rejects larger seeds (fixed in `tools/_common.py`).

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

### Manual validation (A4) ✅
Done: wan21 81f/steps4 (apple rotate, 24MB mp4), wan22 frames100→101
steps5→6 (26MB mp4) — both 200 video/mp4, both videos confirmed.

---

## A5. Chaining + global configuration (backend)

### Contents
- `result_url(filename, type="output")` — used by all 4 tools.
- `normalize_source(image)` → `(filename | url, kind)` — centralized
  filename-vs-URL auto-detection.
- `Settings` runtime: `set_base_url / set_media_base_url / set_api_key` for the
  🎨; persisted in `~/.gradio-comfy-tools.json`.
- `last_generated` per session: handled by the frontend.

### Manual validation (A5) ✅
Done: `scripts/run_chain.py` — generate → edit → upscale → video passing
filenames between steps; green apple rotating video confirmed.

---

## A6. Acceptance criteria (complete backend) ✅

1. `python3 scripts/check_env.py` → TODO OK ✅
2. `pytest` green (55 tests, MockTransport) ✅
3. Smoke + CLI of the 4 tabs manually validated (A1–A4) ✅
4. Full chain A5 validated ✅
5. All of BACKEND.md §5–§6 implemented ✅

---

# Part B — Frontend

## Decision: FastAPI + app.html (not Gradio) ✅ decided

Gradio 6's theming could not reproduce the mockup design (the mockup is the
source of truth per FRONTEND.md). Re-scoped:

- **`mockup.html`** = the design template/spec — **never edited for functionality**.
- **`app.html`** = a working copy of the mockup where the fake buttons call the
  real backend. This is the page served at `/`.
- **`server.py`** (FastAPI) = serves `app.html` at `/` and exposes the API that
  reuses the validated Part A tools. Media (images/videos) is **proxied** via
  `/media/{filename}?type=...` so the browser never talks to the ComfyUI host
  directly (no CORS / safehttpx host-validation issues).

### Server endpoints
| Endpoint | Purpose | Status |
|---|---|---|
| `GET /` | serves `app.html` | ✅ |
| `GET /health` | server + ComfyUI health | ✅ |
| `POST /api/generate` | Generate tab | ✅ |
| `POST /api/edit` | Edit tab (mode edit/restore) | ✅ |
| `POST /api/upscale` | Upscale tab | ✅ |
| `POST /api/video` | Video tab | ✅ |
| `POST /api/upload` | 📁 upload → ComfyUI temp filename | ✅ |
| `GET /media/{filename}?type=` | same-origin proxy of ComfyUI results | ✅ |
| `GET /api/settings` | global settings (for 🎨) | ✅ |

### app.html wiring progress
| Tab | What works | Status |
|---|---|---|
| Generate 🖼️ | family (human-readable label ↔ internal key), AR/MP/steps/seed, LoRA via ⚙️ modal, submit → image + URL + 📋, spinner, button disabled state, reset | ✅ |
| Edit ✏️ | 📁 upload → source field, 🔗 previous, 🖌️/🩹 (edit/restore), before/after compare slider (bar left = original, right = edited), spinner | ✅ |
| Upscale 🔍 | — (compare slider ready, source field + 📁 + 🔗 exist) | ⏳ next |
| Video 🎬 | — (mock player, source field + 📁 + 🔗 exist) | ⏳ after Upscale |

### Shared UI behaviors (done in app.html)
- Loading spinner (96px ring) over the output pane while a job runs + `.busy`
  dim + `:disabled` visual on the action button.
- `api()` with AbortController timeout (240s) so a hung request never leaves
  the button stuck.
- `showResult()` removes only previous result/placeholder, keeps overlays.
- Compare slider ported from `../open-webui-comfy-tools/compare_images`
  (two stacked `<img>`, `clip-path` via `--p`, pointer drag/hover).
- Upload via hidden `<input type=file>` → `POST /api/upload`.

## B4. Remaining (settings + polish)

- 🎨 Comfy Tools dropdown → real server URL / media base URL (writes
  `config.py` via a new `POST /api/settings`), theme toggle.
- ⚙️ advanced modal: already stores values per tab in `app.html`
  (`window.advancedValues`); wire Model name / Diffusion model (JSON) to the
  backend calls (currently only LoRA config is used).
- Video tab: real player (`<video>` from `/media`), frames/steps/seed/negative
  controls wired to `/api/video`.
- Upscale tab: compare slider with "Upscaled", wire to `/api/upscale`.
- Responsive behavior (mockup already handles it via CSS).
