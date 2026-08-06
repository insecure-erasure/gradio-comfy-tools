# Design Document — Gradio Comfy Tools

> **This document is the architecture overview.** The detailed specifications live in:
>
> - **`FRONTEND.md`** — UI specification. **Source of truth: `mockup.html`.** Describes exactly what to build in Gradio, control by control.
> - **`BACKEND.md`** — Service layer specification. **Implementation reference: the tools in `../open-webui-comfy-tools`** (workflows, injection pattern, parameter semantics).

## Overview

Unified Gradio interface that consolidates four ComfyUI-powered tools into a
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
- **Backend**: the Open WebUI tools in `../open-webui-comfy-tools` are the reference for workflow injection, parameter semantics (seed, steps, frames, LoRAs) and ComfyUI REST API interaction. The Gradio backend reimplements the same behavior without Open WebUI-specific plumbing (valves, embeds, HTMLResponse).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ app.py  (Gradio Blocks — layout & state per FRONTEND.md)       │
│   ├── per-tab state (parameters, results)                      │
│   ├── settings: server URL (COMFYUI_BASE_URL), media base URL   │
│   │   (COMFYUI_MEDIA_BASE_URL), theme, default LoRAs / models    │
│   └── tools/  (per tool: workflow loading + injector)          │
├───────────────────────────────────────────────────────────────┤
│ comfy_client.py  (ComfyUI REST client)                         │
│   POST /prompt · GET /history/{id} · POST /upload/image        │
│   GET /view?filename=&type=output                              │
└───────────────────────────────────────────────────────────────┘
```

Generation flow:

1. The user fills in parameters and prompt, then clicks the action button (✨/🖌️/🩹/🔍/🎬) in the bottom bar.
2. `app.py` asks `tools/<tool>` for the workflow with parameters injected (resolve nodes by unique `_meta.title`, same pattern as the Open WebUI tools).
3. `comfy_client.py` does `POST /prompt`, then polls `GET /history/{prompt_id}` until completion.
4. The result (image or video) is served from ComfyUI's output via the
   media base URL: `{COMFYUI_MEDIA_BASE_URL}/view?filename=...&type=output`,
   and displayed in the active tab's output pane.
5. The result URL is available for copying (📋) and chaining: Edit/Upscale/Video
   accept a source image via a **transparent URL text field** overlaid at the
   bottom-left of their output pane (paste an external URL); the 🔗 button
   sits bottom-right and fills the field with the last generation.

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
| `FRONTEND.md` | UI specification — the mockup is the source of truth |
| `BACKEND.md` | Service specification — the open-webui tools are the reference |
| `mockup.html` | Interactive HTML mockup (source of truth for the UI) |
| `app.py` | Main Gradio application (to be implemented) |
| `comfy_client.py` | ComfyUI REST API client (to be implemented) |
| `tools/` | Per-tool modules (to be implemented) |
| `workflows/` | ComfyUI workflow JSON files (copied from `../open-webui-comfy-tools`): `smart_generate_image.json`, `edit_image.json`, `seedvr2_upscale.json`, `generate_video.json`, `generate_video_wan22.json` — see table below |
| `scripts/check_env.py` | Validates a live ComfyUI (nodes + models) against `workflows/` — `python3 scripts/check_env.py [BASE_URL]` |

### workflows/ contents

| File | Tab | Notes |
|------|-----|-------|
| `smart_generate_image.json` | Generate | Z-Image / Krea / FLUX.2 families |
| `edit_image.json` | Edit | flux-2-klein + LoRAs + restore |
| `seedvr2_upscale.json` | Upscale | SeedVR2 |
| `generate_video.json` | Video | Wan 2.1 single path |
| `generate_video_wan22.json` | Video | Wan 2.2 dual high/low path |

