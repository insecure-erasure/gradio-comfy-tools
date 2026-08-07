# Design Document — Comfy Tools

> **This document is the architecture overview.** The detailed specifications live in:
>
> - **`FRONTEND.md`** — UI specification. **Source of truth: `mockup.html`.** Describes exactly what to build, control by control.
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

- **UI**: `mockup.html` is the source of truth for the frontend. `FRONTEND.md` describes it and captures every control and interaction; any UI change must first be applied to the mockup.
- **Backend**: the Open WebUI tools in `../open-webui-comfy-tools` are the reference for workflow injection, parameter semantics (seed, steps, frames, LoRAs) and ComfyUI REST API interaction. Our backend reimplements the same behavior without Open WebUI-specific plumbing (valves, embeds, HTMLResponse).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ server.py  (FastAPI — serves the UI + API)                     │
│   GET /                        templates/index.html (the UI)   │
│   POST /api/{generate,edit,upscale,video,upload}               │
│   GET /media/{filename}?type=  same-origin proxy of results    │
│   GET /health · /api/settings                                  │
│   └── tools/  (per tool: workflow loading + injector)          │
├───────────────────────────────────────────────────────────────┤
│ comfy_client.py  (ComfyUI REST client)                         │
│   POST /prompt · GET /history/{id} · POST /upload/image        │
│   GET /view?filename=&type=output                              │
└───────────────────────────────────────────────────────────────┘
```

- **`mockup.html`** = the design template/spec (source of truth for the UI,
  never edited for functionality).
- **`templates/` + `static/`** = a modular working copy of the mockup (Jinja2
  partials per tab, JS module per concern, CSS by role) where the fake buttons
  call the real backend via `server.py`. This is the page served at `/`.

Generation flow:

1. The user fills in parameters and prompt, then clicks the action button (✨/🖌️/🩹/🔍/🎬) in the bottom bar.
2. `static/js/*` (JS) `fetch()`es `POST /api/<tool>` with the tab's parameters.
3. `server.py` calls `tools/<tool>` for the workflow with parameters injected (resolve nodes by unique `_meta.title`, same pattern as the Open WebUI tools).
4. `comfy_client.py` does `POST /prompt`, then polls `GET /history/{prompt_id}` until completion.
5. The result (image or video) is proxied by `server.py` at `/media/{filename}?type=...` (same-origin, avoids CORS/host validation) and displayed in the output pane; the direct ComfyUI URL is shown for copy (📋) and chaining (🔗).

## Deviations from the original design (already reflected in the docs)

The mockup evolved beyond the original DESIGN.md. The docs are already aligned with the mockup; the summary is here so nobody reimplements the old spec:

1. **⚙️ Advanced**: the gear lives in the **model-row** of Generate, Edit and Video (not in the tab bar). Upscale has **no gear** and no advanced fields (resolution/blend/color stay fixed in the workflow; see BACKEND.md).
2. **Edit has no mode radio** — the mode is chosen with the bottom bar buttons: 🖌️ Edit / 🩹 Restore.
3. **LoRAs are managed exclusively via the advanced modal** — there is no dynamic list / `+ Add LoRA` button in the params pane; each tool configures LoRAs through the `LoRA config (JSON)` field of its modal (Generate, Edit, Video).
4. **Upscale exposes only Seed** (+🎲); resolution/blend/color-correction were removed from the UI (they remain as workflow defaults).
5. **Video Frames = 81–161** (4n+1), not 5–161.
6. **No Custom AR option** in Generate (the hidden custom row is dead code and is not ported).
7. **Action buttons live in the bottom bar** (not in the params panel); Reset is ↺ in the model-row.
8. **Inline labels** W / H / AR / 📐 / 👣 / 🎞️ / 🌱 with tooltips (not "unlabeled" rows).
9. **Theme via manual toggle** in the 🎨 dropdown (no `prefers-color-scheme`).
10. **Global config, no override layers** — the app is single-user: no admin/user hierarchy, no "Override system LoRAs"; `COMFYUI_BASE_URL` and `COMFYUI_MEDIA_BASE_URL` are global settings in the 🎨 dropdown, not per-tool.
11. **Source image URL field** — Edit/Upscale/Video have a transparent text field (bottom-left of the output pane; `🔗` button bottom-right) for the input image URL; `🔗` fills it with the last generation and it persists per tab. Added to the mockup (was not in the original design, which only had attachment buttons in the prompt bar).

## Files

| File | Purpose |
|------|---------|
| `DESIGN.md` | This overview |
| `PLAN.md` | Implementation plan — Part A (backend) done, Part B (frontend) in progress |
| `FRONTEND.md` | UI specification — the mockup is the source of truth |
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

### workflows/ contents

| File | Tab | Notes |
|------|-----|-------|
| `smart_generate_image.json` | Generate | Z-Image / Krea / FLUX.2 families |
| `edit_image.json` | Edit | flux-2-klein + LoRAs + restore |
| `seedvr2_upscale.json` | Upscale | SeedVR2 |
| `generate_video.json` | Video | Wan 2.1 single path |
| `generate_video_wan22.json` | Video | Wan 2.2 dual high/low path |

