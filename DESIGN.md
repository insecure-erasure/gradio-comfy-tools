# Design Document — Comfy Tools

> **This document is the architecture overview.** The detailed specifications live in:
>
> - **`FRONTEND.md`** — UI specification. **Source of truth: the code** (`templates/` + `static/`); the mockup is the historical design template.
> - **`BACKEND.md`** — Service layer specification. **Implementation reference: the tools in `../open-webui-comfy-tools`** (workflows, injection pattern, parameter semantics).

## Overview

Unified web interface that consolidates four ComfyUI-powered tools into a
single multi-tab web application. Each tool occupies its own tab, sharing a
consistent layout: generation output on the left, parameters on the right,
and a full-width prompt bar at the bottom.

| Tab | Tool | Workflow(s) | Reference (../open-webui-comfy-tools) |
|---|---|---|---|
| 🖼️ Generate | smart_generate_image | `smart_generate_image.json` | `smart_generate_image/` |
| ✏️ Edit | edit_image | `edit_image.json` | `edit_image/` |
| 🔍 Upscale | upscale_image | `seedvr2_upscale.json` | `upscale_image/` |
| 🎬 Video | generate_video | `generate_video.json`, `generate_video_wan22.json` | `generate_video/` |

## Sources of truth

- **UI**: the **code** (`templates/` + `static/`) is the source of truth for
  the frontend. `mockup.html` is the historical design template/spec (never
  edited for functionality); `FRONTEND.md` documents the current behavior and
  the deviations from the mockup.
- **Backend**: the Open WebUI tools in `../open-webui-comfy-tools` are the reference for workflow injection, parameter semantics (seed, steps, frames, LoRAs) and ComfyUI REST API interaction. Our backend reimplements the same behavior without Open WebUI-specific plumbing (valves, embeds, HTMLResponse).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ server.py  (FastAPI — serves the UI + API)                     │
│   GET /                        templates/index.html (the UI)   │
│   POST /api/{generate,edit,upscale,video,upload}               │
│   POST /api/check-image         (validate a source URL/filename)│
│   GET /api/progress · POST /api/cancel  (live progress + stop) │
│   GET /media/{filename}?type=  same-origin proxy of results    │
│   GET /health · /api/settings (GET/POST)                       │
│   GET /api/loras · /api/diffusion-models                       │
│   └── tools/  (per tool: workflow loading + injector)          │
├───────────────────────────────────────────────────────────────┤
│ comfy_client.py  (ComfyUI REST client)                         │
│   POST /prompt · GET /history/{id} · POST /upload/image        │
│   GET /view?filename=&type=output                              │
│   GET /models/loras · /models/diffusion_models                 │
└───────────────────────────────────────────────────────────────┘
```

- **`mockup.html`** = the design template/spec (source of truth for the UI,
  never edited for functionality).
- **`templates/` + `static/`** = a modular working copy of the mockup (Jinja2
  partials per tab, JS module per concern, CSS by role) where the fake buttons
  call the real backend via `server.py`. This is the page served at `/`.

Generation flow:

1. The user fills in parameters (via the prompt chips) and prompt, then
   clicks the action button (✨/🖌️/🩹/🔍/🎬) — in the prompt (landscape)
   or the bottom bar / prompt modal (portrait).
2. `static/js/*` (JS) `fetch()`es `POST /api/<tool>` with the tab's parameters.
3. `server.py` calls `tools/<tool>` for the workflow with parameters injected (resolve nodes by unique `_meta.title`, same pattern as the Open WebUI tools).
4. `comfy_client.py` does `POST /prompt`, then polls `GET /history/{prompt_id}` until completion.
5. The result (image or video) is proxied by `server.py` at `/media/{filename}?type=...` (same-origin, avoids CORS/host validation) and displayed in the output pane; the direct ComfyUI URL is shown for copy (📋) and chaining (🔗).

## Deviations from the original design (already reflected in the docs)

The mockup evolved beyond the original DESIGN.md. The docs are already aligned with the mockup; the summary is here so nobody reimplements the old spec:

1. **⚙️ Advanced**: the gear lives in the **per-tab nav toolbar** of
   Generate, Edit and Video (with the model dropdown + ↺). Upscale has
   **no gear** and no advanced fields (resolution/blend/color stay fixed in
   the workflow; see BACKEND.md).
2. **Edit has no mode radio** — the mode is chosen with the action chips:
   🖌️ Edit / 🩹 Restore (order 🪄 · 🩹 · 🖌️; in the prompt field in
   landscape, inside the compact field / modal in portrait).
3. **LoRAs are managed exclusively via the advanced modal** — there is no
   dynamic list / `+ Add LoRA` button in the params pane; each tool
   configures LoRAs through the **visual row editor** of its modal
   (dropdown + strength, up to 4 rows; Generate, Edit, Video).
4. **Upscale exposes only Seed** (+🎲); resolution/blend/color-correction were removed from the UI (they remain as workflow defaults).
5. **Video Frames = 81–161** (4n+1), not 5–161.
6. **No Custom AR option** in Generate (the hidden custom row is dead code and is not ported).
7. **Action chips live INSIDE the prompt field** (landscape: bottom-right
   of the textarea — 🪄/🩹/✨; portrait: the compact bar field holds the
   generation chips only — 🩹/✨ or 🖌️/🎬 — while the 🪄 refine lives
   EXCLUSIVELY in the fullscreen prompt modal, which shows bigger pills);
   Reset is ↺ in the per-tab nav toolbar.
8. **Parameter chips instead of inline labels** — the per-tab controls
   (W / H / AR / 📐 / 👣 / 🎞️ / 🌱) moved out of the params panes into
   chips overlaid on the prompt textarea (📏/👣 Generate, 👣 Edit, 🎞️/👣
   Video), each opening a small popover with the controls; Upscale (no
   prompt) keeps its 🌱 seed control directly in the params pane. The
   prompt fills the whole params pane in landscape; in portrait the chips
   live inside the fullscreen prompt modal (see FRONTEND.md §8.14).
9. **Theme via manual toggle** in the 🎨 dropdown (no `prefers-color-scheme`).
10. **Global config, no override layers** — the app is single-user: no admin/user hierarchy, no "Override system LoRAs"; `COMFYUI_BASE_URL` and `COMFYUI_MEDIA_BASE_URL` are global settings in the 🎨 dropdown, not per-tool.
11. **Source image URL field** — Edit/Upscale/Video have a transparent text
    field (bottom-left of the output pane; `🔗` button bottom-right) for the
    input image URL; `🔗` fills it with the last generation and it persists
    per tab. Added to the mockup (was not in the original design, which
    only had attachment buttons in the prompt bar).
12. **Parameter chips + portrait prompt modal actions** — see the design
    details in FRONTEND.md §3 and §8.14–8.16.

## Files

| File | Purpose |
|------|---------|
| `DESIGN.md` | This overview |
| `PLAN.md` | Implementation plan — Part A (backend) done, Part B (frontend) done: live progress, per-step previews, stop/cancel, galleries; queue position + true concurrent tabs parked indefinitely (2026-08-12 decision) — see §B5 |
| `FRONTEND.md` | UI specification — the **code** (`templates/` + `static/`) is the source of truth; `mockup.html` is the historical spec |
| `BACKEND.md` | Service specification — the open-webui tools are the reference |
| `mockup.html` | Design template/spec — never edited for functionality |
| `templates/` + `static/` | Modular working copy of the mockup wired to the real backend (served at `/`) |
| `server.py` | FastAPI app — renders templates/ + serves static/ + the API (reuses tools/) |
| `comfy_client.py` | ComfyUI REST client (implemented — see PLAN.md A0) |
| `tools/` | Per-tool modules — `_common.py`, `generate.py`, `edit.py`, `upscale.py`, `video.py` done (A0–A4) |
| `workflows/` | ComfyUI workflow JSON files (copied from `../open-webui-comfy-tools`): `smart_generate_image.json`, `edit_image.json`, `seedvr2_upscale.json`, `generate_video.json`, `generate_video_wan22.json` — see table below |
| `scripts/check_env.py` | Validates a live ComfyUI (nodes + models) against `workflows/` — `python3 scripts/check_env.py [BASE_URL]` |
| `scripts/smoke_client.py` | A0 end-to-end smoke test — health/upload/queue/poll/URL |
| `scripts/run_generate.py` | A1 Generate CLI — `--family zimage|krea2|flux2 --prompt "..." [--ar] [--mp] [--steps] [--seed] [--loras]` |
| `scripts/run_edit.py` | A2 Edit CLI — `--image <filename|URL> --mode edit|restore [--prompt] [--steps] [--seed] [--loras]` |
| `scripts/run_upscale.py` | A3 Upscale CLI — `--image <filename|URL> [--seed]` |
| `scripts/run_video.py` | A4 Video CLI — `--image <filename|URL> --model wan21|wan22 --prompt "..." [--frames] [--steps] [--seed] [--negative] [--loras]` |
| `scripts/run_chain.py` | A5 full-chain CLI — generate → edit → upscale → video (filenames between steps) |
| `scripts/probe_previews.py` | Documents the raw ComfyUI per-step preview protocol (binary WS frames) — `python3 scripts/probe_previews.py [--family krea2|flux2|zimage] [--steps N]` |
| `scripts/demo_chain_ws.py` | Dev/demo: a full generate → edit → upscale → video chain over the WS protocol |
| `scripts/listen_ws.py` | Dev: raw WebSocket listener printing the events ComfyUI sends for a queued prompt |

### workflows/ contents

| File | Tab | Notes |
|------|-----|-------|
| `smart_generate_image.json` | Generate | Z-Image / Krea / FLUX.2 families |
| `edit_image.json` | Edit | flux-2-klein + LoRAs + restore |
| `seedvr2_upscale.json` | Upscale | SeedVR2 |
| `generate_video.json` | Video | Wan 2.1 single path |
| `generate_video_wan22.json` | Video | Wan 2.2 dual high/low path |

