# PLAN — gradio-comfy-tools

Phase-based implementation of the project (spec in `FRONTEND.md` / `BACKEND.md`,
UI in `mockup.html`, workflows in `workflows/`). The plan has **two parts**:

- **Part A — Backend** (this document, §A0–A6): ComfyUI infrastructure + one
  tool per tab. **DONE + validated manually.**
- **Part B — Frontend** (§B0–B4): the web UI. **Re-scoped**: FastAPI +
  a modular working copy of the mockup (templates/ + static/) instead of Gradio — see §B below.

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
| `family` | select: `zimage` / `krea2` / `flux2` (backend default `zimage`; the UI sends `krea2` by default) | selects `MODEL_CONFIGS` (model, clip, vae, vae_scale, cfg, steps, sampler, scheduler) |
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

## Decision: FastAPI + modular frontend (not Gradio) ✅ decided

Gradio 6's theming could not reproduce the mockup design (the mockup is the
source of truth per FRONTEND.md). A Gradio experiment lived on branch
`feat/gradio-ui` (kept for reference) — even with deep custom CSS measured via
puppeteer it still felt crude, so it was abandoned in favor of serving the
mockup directly.

- **`mockup.html`** = the design template/spec — **never edited for functionality**.
- **`templates/` + `static/`** = a modular working copy of the mockup (Jinja2
  partials per tab + one JS module per concern + CSS split by role). The fake
  buttons call the real backend. This is the page served at `/`.
- **`server.py`** (FastAPI) = renders `templates/index.html` at `/` (Jinja2),
  serves `static/`, and exposes the API that reuses the validated Part A
  tools. Media (images/videos) is **proxied** via `/media/{filename}?type=...`
  so the browser never talks to the ComfyUI host directly (no CORS /
  safehttpx host-validation issues).

### Server endpoints
| Endpoint | Purpose | Status |
|---|---|---|
| `GET /` | renders `templates/index.html` (+ `static/`) | ✅ |
| `GET /health` | server + ComfyUI health | ✅ |
| `POST /api/generate` | Generate tab | ✅ |
| `POST /api/edit` | Edit tab (mode edit/restore) | ✅ |
| `POST /api/upscale` | Upscale tab | ✅ |
| `POST /api/video` | Video tab | ✅ |
| `POST /api/upload` | 📁 upload → ComfyUI temp filename | ✅ |
| `GET /media/{filename}?type=` | same-origin proxy of ComfyUI results | ✅ |
| `GET /api/settings` | global settings (for 🎨) | ✅ |
| `POST /api/settings` | persist server / media base URL (🎨) | ✅ |
| `GET /api/loras` | LoRA names from ComfyUI (`/models/loras`) | ✅ |
| `GET /api/diffusion-models` | diffusion model names (`/models/diffusion_models`) | ✅ |
| `POST /api/check-image` | validate a source URL/temp filename is an image (server-side, magic-bytes fallback) | ✅ |

### Frontend wiring progress (templates/ + static/)
| Tab | What works | Status |
|---|---|---|
| Generate 🖼️ | model dropdown (Krea 2 default) + ⚙️ + ↺ in nav toolbar; parameters as prompt chips (📏 dims + 👣 steps/seed, popover each — `refactor/unify-action-buttons`); LoRA row editor + model dropdown in ⚙️ modal; submit → image + URL + 📋; spinner; button disabled with empty prompt; reset | ✅ |
| Edit ✏️ | 📁 upload → source field, 🔗 previous, 🖌️/🩹 (edit/restore; 🩹 always active), before/after compare slider, spinner; params as 👣 chip (steps/seed — `refactor/unify-action-buttons`) | ✅ |
| Upscale 🔍 | special layouts (portrait: seed + 🔍 in pane, no bottom bar; landscape: 🔍 above URL row), compare slider, 📁/🔗, reset; seed control stays directly in the pane (no chip — no prompt textarea) | ✅ |
| Video 🎬 | real `<video>` player, Wan 2.1/2.2, frames/steps/seed as 🎞️+👣 chips (`refactor/unify-action-buttons`); ⚙️ modal varies by version (wan22 dual high/low models + LoRAs, per-version config store); negative prompt in modal | ✅ |

### Shared UI behaviors (in static/js)
- Loading spinner (96px ring) over the output pane while a job runs + `.busy`
  dim + `:disabled` visual on the action button.
- `api()` with AbortController timeout (240s) so a hung request never leaves
  the button stuck.
- **Generation lock** (`setGeneratingUi(true|false)` + `applyGenerationLock`
  in `api.js`): while a job runs the prompt textarea is locked (typing
  blocked) and the 🪄 refine + ALL action buttons are disabled — including
  the complementary 🖌️/🩹 in Edit (an edit blocks restore and vice versa)
  and the Upscale buttons wherever they sit; the click-catchers toast
  "Generation in progress…". Re-asserted on tab switch mid-generation
  (`switchTab` rebuilds `#btnCol` with fresh buttons); released in each
  tool's `.finally()`.
- `showResult()` removes only previous result/placeholder, keeps overlays.
- Compare slider ported from `../open-webui-comfy-tools/compare_images`
  (two stacked `<img>`, `clip-path` via `--p`, pointer drag/hover).
- Upload via hidden `<input type=file>` → `POST /api/upload`.
- 🎨 settings menu (theme + server/media base URL) → `GET/POST /api/settings`
  persisted to `~/.gradio-comfy-tools.json`; values shown in the menu.
- Modular structure: `templates/index.html` + `templates/partials/*.html`
  (Jinja2 includes), `static/js/{state,storage,api,player,refine,source,tabs,
  generate,edit,upscale,video,gallery,settings,modal,main}.js`,
  `static/css/{base,layout,components,responsive}.css`. Smoke-tested in a
  DOM (jsdom): all tab flows, resets, settings and modal wiring verified —
  24/24 checks, no JS errors.

## B4. Settings + polish ✅ (done — pending manual validation)

- 🎨 settings menu → ☰ hamburger top-left; real server URL / media base URL:
  `POST /api/settings` persists to `~/.gradio-comfy-tools.json`; theme toggle
  persisted to localStorage. `static/js/settings.js`.
- ⚙️ advanced modal: values stored per tab (`window.advancedValues`);
  model/diffusion are **dropdowns from `/models/diffusion_models`**; LoRAs use
  an **inline row editor** (dropdown + strength stepper ±0.05, up to 4),
  filtered by model directory (`zit/`, `flux2/`, `krea2/`, `wan21/`, `wan22/`).
  Video modal varies by Wan version (wan22 dual high/low) with a **per-version
  config store** (`advancedValues.video.wan21|wan22`) and a wider modal.
- **localStorage persistence** (`storage.js`): per-tab params, advanced
  values, toolbar selections and theme survive page reloads.
- Video tab: **custom player** (`static/js/player.js` — bottom-centered
  ▶/⏸ + ⋮ controls, accent progress line, click/dblclick + fullscreen ⛶
  button; see FRONTEND.md §3.4), Wan 2.1/2.2 selector,
  frames/steps/seed wired to `/api/video`; negative prompt in the modal.
- Upscale tab: special compact layouts (portrait seed+🔍 in pane; landscape
  🔍 above URL row).
- Source URL field: **✓ confirm button** validates the value server-side
  (`POST /api/check-image` — same filename-vs-URL convention as the tools)
  and shows a **preview filling the output pane**; 🔗 and 📁 also preview the
  source. Non-image values toast a clear error (verified live: temp URL
  `image/png`, `/` rejected as `text/html`, missing file → `404`).
- Action buttons disabled when the prompt is empty (click-catcher feedback);
  🩹 Restore and 🔍 Upscale always active.
- ↺ resets per tab restore defaults + clear the tab's output.
- Generated image fills the output pane (100% + object-fit contain).
- Refactor: `app.html` split into `templates/` (Jinja2 partials) + `static/`
  (CSS by role, JS one module per concern); `server.py` renders the template.
  Smoke-tested in jsdom + headless chromium. **Pending: manual validation
  against the live ComfyUI server** (see below).

## B5. Live events + queue (partially implemented — progress painted in the URL row)

> **Status 2026-08-08**: the **numeric stage progress is DONE** — `comfy_client`
> materializes the client_id + fires prompt hooks; `server.py` spawns a per-job
> WebSocket listener (same clientId) and exposes `GET /api/progress`; the
> frontend polls it and paints the stage in the result URL row (`⏳ Queued…` →
> `⚙️ SamplerCustomAdvanced 4/8` → URL). Verified live against the server
> (ComfyUI 0.27.0). **Remaining from B5**: queue position, live *previews*,
> and true concurrent tabs (each tab still blocks on its own `fetch()`; the
> polling endpoint is single-user "most recent job").

### ComfyUI state API (verified 2026-08-07, ComfyUI 0.29.1)

**REST**:
| Endpoint | Gives | Notes |
|---|---|---|
| `GET /queue` | `{queue_running: [...], queue_pending: [...]}` | what is running/pending, with prompt ids |
| `GET /prompt` | `exec_info.queue_remaining` | how many jobs remain |
| `GET /history/{prompt_id}` | status + outputs when done | already used by `comfy_client.wait_for_output` |

> REST gives **counts, not percentages** — it says "1 running" but not how far.

**WebSocket `GET /ws?clientId=<uuid>`** (verified):
| Event | Meaning |
|---|---|
| `status` | `exec_info.queue_remaining` on connect (queue position) |
| `executing` (`data.node`) | each workflow node as it runs (model load, CLIP, KSampler, VAE decode, …) |
| `progress` (`data.value/max`) | **numeric progress** (e.g. 2/4 = 50%) — the real percentage |
| `executed` (`data.output.images[...]`) | node output (the result image/video, and previews) |
| `execution_success` / `execution_error` | prompt finished / failed |
| (extras if installed) | `crystools.monitor`, `progress_state` |

> **Key detail**: WS events are **filtered by `clientId`** — you only receive
> `executing`/`progress`/`executed` for the prompt you launched **with that same
> `clientId`**. A fresh `clientId` (e.g. just listening) only sees the global
> `status`, not another session's progress.

### Live previews (verified 2026-08-07) — KSamplers do NOT send images

Investigated whether the KSampler's live previews (the ones the ComfyUI
frontend shows while sampling) can be reused. Verified with a real 6/10-step
generation:

- `progress` events carry **only numbers** — `{value, max, prompt_id, node}` —
  **no image, no latent, no base64** (searched the whole ws stream for
  `latent`/`preview`/`base64`: none present).
- The only `executed` with an image was the final `RandomPreviewImage` node
  (1 image at the end, not during sampling).
- KSampler/KSamplerAdvanced/SamplerCustomAdvanced have **no preview option** in
  their inputs (`/object_info`).

**Why the ComfyUI frontend shows live previews then**: it is a **frontend
feature** — the browser decodes the intermediate latent itself with a tiny
approx VAE (e.g. `taesd_decoder`, `taef1_decoder` from `models/vae_approx`)
when it sees the `progress`. The ws does **not** send the latent, so we cannot
reproduce that from the frontend without a node.

**To get real live previews** (option for B5): add a preview node to the
workflow that decodes the intermediate latent on each step, e.g.:

- `WanVideoTinyVAELoader` (loads `taef1_decoder`/`taesd_decoder` from
  `models/vae_approx` — verified these are installed) as the VAE, plus
- `ImagePreviewFromLatent+` (input `latent` + `vae`, emits `IMAGE`) connected
  to the sampler's intermediate latent, plus optionally `FastPreview` to
  re-compress (JPEG/PNG/WEBP).

That node would emit `executed` with an image **per step**, which the ws
relays — giving real in-progress previews in the frontend. (Not yet executed in
this repo's workflows; the per-step emission is inferred from the node design.)

### What remains from B5
- **DONE (2026-08-08, branch feat/tvae-preview)**: **live per-step previews in
  Generate, Edit (edit/restore) and Video (Wan 2.1/2.2)** — the same
  mechanism the ComfyUI web UI uses, no preview node needed. The sampler decodes its intermediate latent each step and streams
  it over the WS as binary frames; the backend captures the latest frame per
  job and the frontend paints it under the spinner while the job runs.
  - `comfy_client.queue_prompt(extra_data=...)` — Generate, Edit and Video
    queue with `extra_data={"preview_method": "auto"}` (the CLI default is
    NoPreviews; the flag is per-prompt and auto-reset). Video: the
    KSamplerAdvanced(s) preview the FIRST frame of the 5D latent each step
    via the built-in Latent2RGB previewer (Wan21/Wan22 have
    latent_rgb_factors; no TinyVAE needed). wan22's two KSamplers run HIGH
    then LOW, so the previews arrive in flow order with their node_id —
    the URL row shows "KSampler HIGH v/max" then "KSampler LOW v/max".
    Validated live: wan21 2 steps → 2 previews from node 876; wan22
    confirmed working in the UI.
  - `server.py` WS listener sends the handshake `{"type": "feature_flags",
    "data": {"supports_preview_metadata": true}}` as its first message and
    parses binary frames: event 4 `PREVIEW_IMAGE_WITH_METADATA` (`>I(4) +
    >I(len_json) + JSON + JPEG`) and legacy event 1 (`>I(4) + >I(type) +
    bytes`). Only the LAST preview per job is kept (bounded memory, ~50KB);
    it is dropped when the job finishes or is cancelled (`_mark_job_result`
    pops it) so nothing stale is ever served and no leak accumulates.
  - `GET /api/progress` serves `active.preview` as a `data:image/jpeg;base64,…`
    while the job runs.
  - Frontend (`api.js`): paints an `<img class="preview-live">` in the
    output pane of the tab that started the generation, and ONLY while that
    tab is active — switching tabs mid-generation keeps capturing but stops
    painting; coming back resumes with the latest frame. While painted it
    hides (restores on cancel) the placeholder / previous result / source
    preview / compare slider / video mock so it fills the pane and stays
    centered. `stopProgressPolling` removes it; `showResult`/`clearPane`
    also drop it so the final result replaces the preview. The spinner
    stays on top (`.busy` z-index).
  - Verified live against the server: flux2 8 steps → `/api/progress` served
    a ~75KB data-URL preview mid-generation, job finished → `active: null`.
    Probe script `scripts/probe_previews.py` documents the raw protocol
    (4 previews per 4-step run for flux2 and krea2).
- **DONE**: per-job WS listener (daemon thread, same clientId) + `GET
  /api/progress` + the UI paints the stage/% in the result URL row
  (polling; the blocking `wait_for_output` stays as the completion fallback).
- **DONE**: **⏹ Cancel (by transformation)** — while a generation runs the
  action button that started it (✨/🖌️/🩹/🔍/🎬) transforms into the ⏹
  stop button (like 🪄→⏹; `makeStopButton`/`restoreStopButton` in api.js);
  the small corner ⏹ in the URL row was removed. It calls `POST
  /api/cancel` (`/interrupt` + `/queue delete`) and aborts the in-flight
  fetch; the 📋 copy button is hidden while generating and restored on
  settle.
- **FIX (2026-08-09)**: **⏹ stop button unclickable during a generation** —
  the `.btn-col.generating` rule showed the click-catcher overlay on EVERY
  action button, including the stop-transformed trigger (which is ENABLED),
  so clicks on ⏹ hit the invisible catcher ("Generation in progress…"
  toast) and never cancelled. Fix: `.btn-col.generating
  .btn-wrap:has(.btn-generate:not(:disabled)) .btn-catcher { display: none }`
  — the catcher only overlays DISABLED buttons. Also: the prompt modal's
  stop button now matches the actual trigger (🩹 restore → 🩹 becomes ⏹;
  ✨/🖌️/🎬 → ✨ becomes ⏹), and `switchTab` refreshes the modal actions so
  a tab switch with the modal open doesn't leave stale glyphs/visibility.
- **DONE (2026-08-09, `refactor/unify-action-buttons`)**: **parameter AND
  action chips inside the prompt field** — the per-tab parameters moved
  out of the params panes into prompt chips (📏/👣 Generate, 👣 Edit,
  🎞️/👣 Video) each with its own popover (`#chipPopover`), and the action
  buttons (✨/🖌️/🩹/🎬 + 🪄) became chips too (`.btn-col` moved inside
  `.prompt-input-wrap`). Landscape: the prompt fills the whole params
  pane; portrait: the compact bar field holds the action chips (generate
  without the modal), and the fullscreen prompt modal shows the ✕ + big
  pills (🪄/🩹/✨). Upscale (no prompt) keeps its seed control in the
  params pane. See FRONTEND.md §8.14–8.16.
- **FIX (2026-08-09)**: **videos unplayable in portrait** — the `/media`
  proxy buffered the whole file before responding, so `<video>` (which
  issues Range requests) couldn't play until the full Wan MP4 downloaded.
  Fix: `/media` now STREAMS and honors `Range` (206 for partials,
  Content-Range/Accept-Ranges pass through).
- **FIX (2026-08-09)**: **gallery badge original-prompt hint** — reachable
  by click/tap (not just hover; touch has no hover) and full-screen-width
  in portrait (was a cramped fitted pill).
- **DONE (2026-08-09, `feat/video-player-controls`)**: **custom video player
  controls** — replaces the native browser controls (their full-width bar
  collided with the pane's overlay buttons 🔗/📁 and the source URL field):
  bottom-centered ▶/⏸ + ⋮ (glyphs optically centered; ⋮ is a placeholder
  for the options menu), a thin ACCENT progress line at the video's bottom
  edge (rAF-driven, always visible), a fullscreen ⛶ overlay button
  top-right (same style as the compare sliders' button; becomes ✕ in
  fullscreen, kept in sync by `fullscreenchange`), **single click toggles
  play/pause, double click toggles fullscreen** (controls excluded),
  portrait uses larger touch targets. Autoplay muted loop kept. See
  FRONTEND.md §3.4.
- **DONE (2026-08-10)**: video player polish — the ▶/⏸ button now **follows
  the playback state** (⏸ playing / ▶ paused, synced via `play`/`pause`/
  `ended`; previously the glyph froze on ⏸ because `setGlyph` was only
  called at creation); **leaving the Video tab pauses a playing video**
  (`pauseActiveVideo()` in `player.js`, called from `switchTab`) so it
  doesn't keep consuming resources in the background.
- **DONE (2026-08-10)**: **progress bar is now a scrubber** — hover (or
  touch on mobile) doubles the line height (3→6px) and reveals a circular
  accent thumb + shaded tooltip with the position in tenths of a second
  (seconds, e.g. `3.4s`); dragging or tapping **seeks the video, playing or paused**
  (pointer events + capture, `touch-action: none` so the drag never scrolls
  the page). The 12px hit area is flush with the pane's bottom overlay
  buttons (📁/🔗, URL field — bottom:12px) so they stay fully clickable.
  `role=slider` + aria attrs on the bar; a `seeked` listener repaints the
  fill when paused. See FRONTEND.md §3.4.
- **DONE (2026-08-08)**: **fullscreen preview for images** — ported from the
  reference (`smart_generate_image` / `edit_image` / `upscale_image`),
  adapted to this single-page app. Implemented in `static/js/gallery.js` +
  the `templates/partials/gallery_overlay.html` overlay. **TWO SEPARATE
  galleries** (user requirement):
  - **Generate (lightbox)**: clicking the result image (or the top-right ⛶
    button) opens a fullscreen **lightbox** via the Fullscreen API with
    gallery navigation (‹ ›, "n/N" counter bottom-right, ArrowLeft/Right).
    It navigates the
    **generated history** — `window.galleryGenerated`, a session registry
    that survives the pane only showing the last result (the history no
    longer gets lost). **Close ✕ is top-RIGHT, download top-LEFT** (inverted
    vs the reference — project decision).
  - **Edit/Upscale (compare)**: the ⛶ button opens a fullscreen overlay with
    its own interactive slider; the gallery there **ONLY navigates the
    edited/restored/upscaled comparisons** (never generated images), the
    AFTER image being the identity (like the reference's #thumb).
  - **Prompt display (updated 2026-08-11)**: the prompt is **no longer a
    bottom caption**. A **Show prompt** button sits bottom-center (only when
    the entry has a prompt) and **hovering it is enough** — the prompt
    appears as a **bottom panel**; **clicking the button hides it and PINNS
    the panel open** (`promptPinned`). ALL gallery text boxes share ONE
    unified family (`.gallery-prompt-btn`, `.gallery-prompt-box`,
    `.gallery-badge`, `.gallery-counter`, compare-slider labels): system-ui
    weight 400 (no bold), 13px/1.5, `rgba(28,28,28,.72)` surface, 1px
    border, 10px radius, `8px 14px` padding, same shadow, `text-align:
    left` (the button is centered). Both prompt boxes use the same
    container (`left:50% + translateX(-50%)`) and max-width
    (`min(560px, 86vw)`); in portrait they expand to full width (margins
    0 12px). The panel is pointer-transparent; it hides on pointer leave,
    Escape, navigation and gallery close; **any open box closes on a click
    anywhere** (`closeTextBoxes()` restores the badge + button).
  - **Transformation behavior (user requirement, updated 2026-08-08)** —
    edits/restores **APPEND** a new entry to the generated history (the
    original image stays), upscales **REPLACE** the source entry:
    - **Edit ✏️ / Restore 🩹**: the appended entry's own text is what the
      Show prompt modal shows; if the source was itself a gallery
      image, its prompt is kept as `originalPrompt`. **Clicking the
      "Edited"/"Restored" badge hides it and shows a single box
      (`#galleryBadgeBox`) with ONLY the ORIGINAL prompt** (no label, no
      transformation text; nothing if there is no original prompt).
      Restore may have no prompt — the Show prompt button is hidden but
      the badge still opens the original-prompt box. Edits of non-gallery
      sources (uploads / external URLs) have no original prompt, so the
      badge click shows nothing.
    - **Upscale 🔍**: **replaces** the source entry in place — the
      generation prompt stays as the Show prompt content, badge "Upscaled"
      top-center, **informational only (`.no-action`, default cursor)** — no
      click action (an upscale has no original prompt to show).
    - Identification by ComfyUI filename (`filenameFromUrl` handles
      `/media/..`, `/view?filename=..`).
  - **Video**: still NOT navigable in the gallery (deferred decision; the
    player is now the custom one, `player.js` — but gallery navigation
    remains out of scope); the result carries a `data-video-gallery="1"`
    marker and its URL is collected in `window.galleryVideos` for a
    **future video gallery — revisit later**.
- **FIX (2026-08-08)**: **LoRA modals broken on Windows (dual-boot)** — the
  server (`http://akari.home`, now booted into Windows) returns LoRA names
  with `\` separators (`flux2\...`), but `loraOptionsForContext()` matched
  with a `/` prefix, so every dropdown came up empty: "＋ Add LoRA" added a
  row with an empty name that was then saved as a phantom "loaded" LoRA.
  Fixes in `modal.js`:
  - `loraOptionsForContext()` is **separator-agnostic** and no longer
    excludes anything: LoRAs whose directory matches the current model
    context come first, every other LoRA after (ComfyUI resolves unique
    names without the dir); the value is the full name as returned.
  - `renderModalLoraRows()` preselects saved rows **separator-agnostically**
    (a Linux-style saved name restores on Windows and vice versa); a saved
    LoRA that no longer exists shows "— not available —" instead of
    silently becoming a different LoRA.
  - By default **no LoRA is loaded**: `parseLoraJson`/`loraSetsToJson` drop
    empty-name rows, and "＋ Add LoRA" refuses to add a row when the server
    has no LoRAs. Verified against the live endpoint (54 LoRAs, all `\`)
    and in jsdom (dropdown listing, default empty state, separator
    normalization, not-available placeholder, wan22 HIGH/LOW editors).
- **FIX (2026-08-08, superseded 2026-08-11)**: **per-tab prompts independent
  per tool** — originally the `#promptInput` textarea was a single shared
  element relocated between tabs (saved/restored via `promptsByTab`), which
  could mix values. **Now each tab has its OWN textarea**
  (`#promptInputGenerate/Edit/Video`, class `.prompt-input`, `data-tab`) —
  values can never mix; `switchTab()` only toggles which field is visible
  (`.prompt-input.active`), `clearPrompt` (✕) clears only the active tab's
  field, typing keeps the per-tab store (`promptsByTab`) + localStorage in
  sync, restored once at startup. Verified in
  jsdom: switching generate → edit → generate preserves both prompts,
  passing through Upscale (no prompt) loses nothing, ✕ clears only the
  active tab, and reload restores each tab's text.
- **FIX (2026-08-08)**: **the ⛶ compare gallery keeps every edit/restore/
  upscale of the session** — it previously collected its entries by scanning
  the live DOM (`[data-gallery="1"]`), but each tab has a SINGLE compare
  slider that is reused for every result, so the first edit vanished from
  the gallery as soon as the second one landed. `edit.js`/`upscale.js` now
  register each comparison in a session registry (`window.galleryComparisons`
  via `addCompareEntry`, deduped by the AFTER image URL);
  `collectCompareEntries()` reads the registry (the DOM scan stays as a
  fallback for a reload that lost the registry). The ↺ reset drops the
  tab's entries from the registry too (matching the existing DOM-marker
  cleanup in `clearPane`). Verified in jsdom: two edits + one upscale all
  survive in the gallery, reset clears only its own tab, dedup works,
  `openCompareFullscreen(kind)` still positions correctly, and the real
  `generateEdit`/`generateUpscale` flows register their comparisons.
- **FIX (2026-08-08)**: **portrait tabs dropdown** — the nav bar is too
  small on vertical displays (<1024px), so the four tab buttons condense
  into a dropdown (`#tabsDropdown` in `nav.html`): the trigger shows the
  ACTIVE tab (icon only + ▾ caret; the labels appear only when the menu
  opens) and the menu lists all four with the
  active one highlighted. The inline `.tab-btn` stay in the DOM (hidden by
  `responsive.css`; landscape keeps them). `updateTabsDropdown()` syncs
  the trigger icon + highlight at the end of `switchTab`; open/close is
  `toggleTabsDropdown`/`closeTabsDropdown` (the menu is `position: fixed`
  and JS anchors it under the trigger — the nav's `overflow-x:auto` would
  clip an absolute one; click-outside closes; forced
  close when crossing the breakpoint in `main.js`). Portrait also hides
  the toolbar's **Model** label (`.tabs-toolbar .toolbar-model label`);
  landscape keeps it.
- **FIX (2026-08-08)**: **portrait prompt modal** — the prompt becomes a
  compact **single-line field** in the bottom bar spanning its full width;
  the ✕ clear and 🪄 refine buttons are **hidden in the bar** (they exist
  ONLY inside the prompt modal), while the action buttons
  (`.btn-col`) stay outside. The Generate **W/H read-only parameters are
  hidden** in portrait (`#tab-generate .params-pane .field-inline:has(.readonly-field)`
  — the grid drops to 4 columns: AR, MP, Steps, Seed).
  *(Superseded 2026-08-09 by `refactor/unify-action-buttons`: the params
  moved into prompt chips (📏/👣/🎞️) and the Generate/Edit/Video params
  panes are hidden entirely — see the frontend wiring table above.)*
  **Tapping the field
  opens a fullscreen
  prompt modal** (`#promptModal`): `openPromptModal()` relocates the same
  `.prompt-input-wrap` into it (`.modal-mode` — large textarea, overlay
  buttons back to the original ✕ top-right / 🪄 bottom-right layout, ✓
  Done header button); `closePromptModal()` moves it back before the
  button column. Closed when crossing the breakpoint (`main.js`). The
  modal **fits the mobile keyboard**: `fitPromptModal()` listens to
  `window.visualViewport` resize/scroll and sets the modal's top+height
  to the real visible area (cleared on close), so the keyboard never
  covers the textarea.
- **TODO (after fullscreen)**: **queueing** — see below.
- **Remaining**: queue position and true concurrent tabs (each tab still
  blocks on its own `fetch()`; `/api/progress` is single-user "most recent
  job"). The per-step live previews are DONE (see "What remains from B5"
  above — the ws `preview_method:auto` mechanism, no preview node needed).

### Manual validation (B5)
Launch a generation in the UI; verify the result URL row shows live progress
(%, node stage) updating in real time (`⏳ Queued…` → `⚙️ SamplerCustomAdvanced
4/8` → the result URL on completion).

**PENDING manual validation (2026-08-08, after the gallery feature + cache
fix):**

- **Gallery in a live session (not stubbed)**: generate 2+ images, open the
  lightbox (click the result or ⛶) and verify the history navigates all of
  them (counter n/N, ‹ ›, ←/→); then edit/restore one of them and verify it
  APPENDS a new entry (Show prompt = edit text, badge click = original
  prompt box) while the original stays; upscale one and verify it REPLACES
  its entry (Show prompt = generation prompt, badge "Upscaled" — no click
  action). Also verify the Show prompt panel appears on hover over the
  button and that clicking the button pins it open (button hides); a click
  anywhere closes it and restores the badge + button; Escape / navigation
  also close. Confirm the ⛶ compare
  overlay in Edit/Upscale only lists edited/restored/upscaled comparisons
  **and that several edits/restores/upscales done on the same tab all stay
  in the gallery** (regression: the first edit used to vanish once the
  second one landed — fixed 2026-08-08; append behavior 2026-08-08).
- **Stale-cache fix**: with the server now serving `Cache-Control: no-cache`
  on `/static`, a normal refresh (F5) must pick up new JS/CSS without a
  hard reload — the "gallery only shows the last generated image" bug was a
  stale pre-fix `gallery.js` (2a36a53).

---

## C1. Cleanup: dead CSS pruning (done 2026-08-08 — CSS removed; JS candidates left by design)

The CSS (~1.4k lines across base/layout/components/responsive) carried rules
inherited from the mockup that the working UI no longer uses. This was a
low-risk cleanup; it does not change behaviour.

### What was removed (verified dead — no element matches them in the DOM)

| Selector | Where | Reason |
|---|---|---|
| `.output-overlay-btn.top-right` | components.css | overlay buttons only use `bottom-right`/`bottom-right-left`; no element has `top-right` |
| `input[type="range"]` + `::-webkit-slider-thumb` + `.range-value` | components.css | no `<input type="range">` anywhere (steppers are `type="number"`) |
| `.radio-group` + `.radio-btn` (base/hover/active) | components.css | segmented control of the mockup; the working UI uses plain buttons |
| `.pane-loading` | layout.css | no reference in templates/ or JS |
| `.model-row` (+ `.field-inline`, ` select`) | layout.css | the nav toolbar uses `.toolbar-model`; no `.model-row` element exists |
| `.toggle-row` + `.toggle-switch` (on/::after) | components.css | modal.js has a `type:'toggle'` renderer case, but no modal config uses it, so no element is ever created |

91 lines removed (79 components.css + 12 layout.css). Brace balance intact
across all 4 files; `pytest` stays green (91 passed).

### Verified ALIVE (NOT removed)
- `.video-mock` + `.play-btn` / `.bar` / `.progress` — the mock placeholder
  IS in the DOM (`tab_video.html`) and is shown/hidden by `api.js clearPane`,
  `source.js` and `video.js`. It is the video placeholder, not leftover CSS.
- `#genCustomRatio` / `.gen-dim` — the hidden custom-ratio row exists in the
  HTML (`display:none`) and `generate.js` references it; it never had CSS
  rules of its own (styling comes from `.field-row`/`.field-inline`).
- `.modal-model-select` — generated by `modal.js`; styled by `.field select`.
- Duplicates: no exact duplicate selector blocks remain (the `.output-pane` /
  `.params-pane` repetitions are distinct `@media` queries).
- The stray `pointer-events: none; }` typo-orphan and the duplicated
  `.compare-slider .handle` mentioned in the old audit are already gone.

### Remaining (intentionally left — JS, not CSS)
- `selectRadio()` in `tabs.js` — dead (no `.radio-btn` element exists, no
  callers). Harmless; remove with the mockup-parity cleanup if wanted.
- The `f.type === 'toggle'` renderer case + `toggles` collection in
  `modal.js`/`saveAdvanced()` — dead (no config uses `type:'toggle'`); its
  CSS was removed, so leaving the case means a future toggle would need the
  CSS re-added. Offer to remove it as part of a JS cleanup.

### Validation
- `pytest` green (91 passed, no behaviour change). ✅
- DOM/coverage check: rendered the page via Jinja2 + grepped every selector
  against templates/ + static/js/ (static DOM + runtime-generated classes). ✅
- Visual regression: still needs a manual click-through of the 4 tabs
  (portrait + landscape) by the user.
