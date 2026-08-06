# Frontend Design — Comfy Tools

> **Source of truth: `mockup.html`.** This document describes the mockup as implemented today. If this document conflicts with the mockup, the mockup wins; if this document conflicts with the old `DESIGN.md`, this document wins (the deviations are summarized in `DESIGN.md`).
>
> The implementation must reproduce this behavior (see §5 for how the mockup maps to the real app).

## 1. Layout

Full-screen app (`100dvh`, no page scroll), in columns:

```
┌───────────────────────────────────────────────────────────────┐
│ Tabs bar: [🖼️ Generate] [✏️ Edit] [🔍 Upscale] [🎬 Video]  │ 🎨 Comfy Tools ▾ │
├───────────────────────────────┬───────────────────────────────┤
│  Output pane (flex 6)         │  Params pane (flex 4)         │
│  result / slider / video      │  per-tab controls,            │
│  background #111122, centered │  scrollable, 280–480px        │
├───────────────────────────────┴───────────────────────────────┤
│  Prompt bar: [textarea + URL + 📋]  [action button ✨🖌️🩹🔍🎬] │
└───────────────────────────────────────────────────────────────┘
```

- **Tabs bar**: `.tabs-output-zone` (flex 6) with the 4 tab buttons + `.tabs-params-zone` (flex 4, min 280px / max 480px, left border) with the `🎨 Comfy Tools ▾` dropdown title.
- **No ⚙️ in the tabs bar** (deviation from the original design; the gear lives in the model-row of Generate and Video).
- **Prompt bar** (`bottom-bar`): always visible, `padding: 8px`, containing the prompt column (multi-line textarea + result URL row with 📋 copy button) and a 44px action column with the active tab's action button(s).

### Responsive

- **< 1024px**: tab text labels are hidden (icons only); the `.split` stacks to a column: output on top (`max-height: 50vh`), params below (natural scroll), prompt at the bottom.
- **< 768px**: more compact paddings.

## 2. Tabs and per-tab bottom bar

| Tab | Icon | Action buttons (bottom bar) | Prompt visible | Prompt placeholder |
|---|---|---|---|---|
| Generate | 🖼️ | `✨ Generate` | Yes | "Describe the image you want to generate in detail..." |
| Edit | ✏️ | `🖌️ Edit` + `🩹 Restore` (secondary style) | Yes | "Describe the edit you want to apply (e.g., \"change the background to a beach at sunset\")..." |
| Upscale | 🔍 | `🔍 Upscale` | **No** (textarea hidden) | — |
| Video | 🎬 | `🎬 Video` | Yes | "Describe the motion and action (e.g., \"a cat walking slowly through a field of flowers, gentle breeze\")..." |

- On tab switch: each tab's parameters **persist** (the DOM is not rebuilt); the copyable result URL row is **cleared** (📋 button disabled). `lastGeneratedUrl` itself persists for chaining (🔗 fills the source URL field of Edit/Upscale/Video).
- Shortcuts: `Ctrl+1..4` switches tabs; `Esc` closes the modal.

## 3. Control inventory per tab (exact to the mockup)

### 3.1 Generate 🖼️

**model-row**: `Model` label + dropdown + `⚙️` gear + `↺` reset.

| Model | auto steps | vae scale |
|---|---|---|
| Z-Image Turbo (default) | 10 | 16 |
| Krea 2 | 8 | 8 |
| FLUX.2 Klein | 8 | 64 |

**Row 1** (inline, no field labels — just letters): `W` readonly · `H` readonly · `AR` dropdown · `📐 MP` stepper.

- W/H: read-only fields showing the live calculation (initial static HTML values are 832×1248, **recalculated on load** — see §4.1).
- AR: dropdown `2:3` (default), `1:1`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`. **No Custom option** (the old Custom W/H is dead code in the mockup — `genCustomRatio` never shows — and is not implemented).
- MP: stepper, range 0.1–2.0, step 0.1, default 1.0.

**Row 2**: `👣 Steps` stepper (1–15, default 10, auto-updates on model change) · `🌱 Seed` stepper (≥ 0, disabled when random) + `🎲` checkbox (checked by default).

**LoRAs**: none in the params pane — LoRA management lives in the advanced modal (`LoRA config (JSON)` field, see §4.6).

### 3.2 Edit ✏️

**Output pane**: `📁` overlay (top-right, "Upload image") + transparent URL field (bottom-left) + `🔗` button (bottom-right) over the **compare slider** (Original | Edited).

**model-row**: `Model` label + dropdown (only `flux-2-klein-9b-nvfp4`) + `⚙️` gear + `↺` reset.

**Row**: `👣 Steps` stepper (1–15, default 6) · `🌱 Seed` stepper + `🎲` (checked).

**LoRAs**: none in the params pane — managed via the advanced modal (`LoRA config (JSON)`, reachable through the ⚙️).

### 3.3 Upscale 🔍

**Output pane**: `📁` overlay (top-right) + transparent URL field (bottom-left) + `🔗` button (bottom-right) over the **compare slider** (Original | Upscaled).

**model-row**: `Model` label + read-only field `SeedVR2` + `↺` reset. **No ⚙️.**

**Row**: only `🌱 Seed` stepper + `🎲` (checked). **No resolution/blend/color sliders** (deviation from the original design; they remain as workflow defaults, see BACKEND.md).

### 3.4 Video 🎬

**Output pane**: `📁` overlay (top-right) + transparent URL field (bottom-left) + `🔗` button (bottom-right) over a mock video player (▶ button + progress bar).

**model-row**: `Model` label + dropdown (`Wan 2.1` default, `Wan 2.2`) + `⚙️` gear + `↺` reset.

**Row**: `🎞️ Frames` stepper (81–161, step 4, default 81, snaps to 4n+1) · `👣 Steps` stepper (4–10, default 4) · `🌱 Seed` stepper + `🎲` (checked).

**Negative Prompt**: textarea field (2 rows) in the params pane, placeholder "Optional — overrides default".

## 4. Mockup interactions (behavior to replicate)

### 4.1 Resolution calculation (Generate)

W/H are derived from MP × AR × vae scale and update live on any change (model, AR, MP):

```
total_pixels = megapixels × 1_000_000
raw_w = √(total_pixels × w_ratio / h_ratio)
raw_h = raw_w × h_ratio / w_ratio
width  = max(vae_scale, round(raw_w / vae_scale) × vae_scale)
height = max(vae_scale, round(raw_h / vae_scale) × vae_scale)
```

- `vae_scale` per family: Z-Image Turbo 16 · Krea 2 8 · FLUX.2 Klein 64.
- Changing the model family **sets steps automatically** (10/8/8) and recalculates W/H.
- Note: the static initial HTML values (832×1248) do not match the formula (2:3 @ 1.0 MP @ vae16 → **816×1232**); the mockup recalculates them on load. The real app must **calculate on init**, not hardcode.
- Clamps: MP 0.1–2.0; steps 1–15.

### 4.2 Seed + 🎲 (all tabs)

- `🎲` checked (default) → seed input disabled; on submit a random seed is generated.
- Typing a value in the input → unchecks `🎲` and enables the input.
- The stepper ± buttons are disabled along with the input (CSS `:has(input:disabled)`).
- Minimum range 0 (no maximum).

### 4.3 Steppers

± component with centered numeric input. Steps/Seed step 1; MP step 0.1; Frames step 4 with **4n+1 snap** (and 81–161 clamp): `val = round(val/4)*4 + 1`.

### 4.4 Compare slider (Edit and Upscale)

Draggable divider (pointer events), Original/Edited (or Upscaled) labels, handle + divider line. Interactive in the mockup; implemented as two stacked `<img>` with `clip-path` via `--p` (ported from the reference compare_images).

### 4.5 Source image URL field (Edit/Upscale/Video)

Transparent text field overlaid at the **bottom-left** of the output pane; the `🔗` button is at the **bottom-right**. The field provides the **input image** for the tool:

- The user can paste an external image URL directly into the field.
- `🔗` fills the field with the last generated URL (`lastGeneratedUrl`); if none exists yet, a toast says so. `lastGeneratedUrl` persists across tab switches so the field can be filled after generating in another tab.
- Each tab keeps its own field value (persists on tab switch).
- On generate, the field value is the tool's `image` input (auto-detected as URL vs filename by the backend — see BACKEND.md §6). If empty, the app should prompt for a source (or use 📁 upload / 🔗).
- Styling: translucent background (`rgba(0,0,0,.35)`), subtle border, white text, placeholder "Paste image URL…", accent border when filled. Width is **relative to the output pane**: 50% of it (mobile: 70%), so it scales with the viewport instead of a fixed px.

### 4.6 🎨 Comfy Tools ▾ dropdown

Opens a menu with two sections:

- **Appearance**: `🌓 Toggle light / dark theme` — manual toggle switching CSS custom properties (dark default: `--bg #1a1a2e`, `--surface #16213e`, `--accent #e94560`, `--text #eaeaea`, `--border #2a2a4a`; light: `#f0f0f5`/`#ffffff`/… and output background `#eaeaef`). **No `prefers-color-scheme`** (deviation from the original design).
- **ComfyUI Connection**: `🔌 Server URL` (shows `localhost:8188`) · `🖼️ Media base URL` (shows `default`). WIP placeholders in the mockup. **These are global settings** — there is exactly one server URL (`COMFYUI_BASE_URL`) and one media base URL (`COMFYUI_MEDIA_BASE_URL`, covers images and videos) for the whole app, not per-tool values.

### 4.7 Advanced modal (⚙️)

Single modal, content rendered dynamically per active tab (`currentTab`). Reachable from Generate, Edit and Video (⚙️ in their model-rows); Upscale has no gear and no advanced fields.

No override layers and no per-tool base URL: the app is single-user (no admin/user LoRA hierarchy, no "Override system LoRAs"), and the ComfyUI server URL and media base URL (`COMFYUI_MEDIA_BASE_URL`) are global settings in the 🎨 dropdown.

| Tab | Fields |
|---|---|
| Generate | `Model name` (text) · `LoRA config (JSON)` (textarea) |
| Edit | `LoRA config (JSON)` |
| Upscale | *(none — resolution/blend/color stay as workflow defaults; media base URL is global)* |
| Video | `Diffusion model (JSON)` (textarea) · `LoRA config (JSON)` |

Footer: `Cancel` + `Save`. Esc or ✕ closes without saving; Save applies and closes. In the real app values persist per tab for the session.

### 4.8 Toast

Floating bottom notifications (`showToast`) for WIP and statuses ("Workflow submitted to ComfyUI", etc.). In the real app this is the mockup's toast element (already implemented in `app.html`).

### 4.9 Result URL

`setResultUrl(filename)` → `{baseUrl}/view?filename=...&type=output`, shown in the row under the textarea with a 📋 copy button (disabled until a result exists).

## 5. How the mockup maps to the implementation

The UI is `app.html` — a working copy of the mockup where the WIP buttons call
the real backend. Each mockup element has its counterpart in the implementation:

| Mockup element | In `app.html` / `server.py` |
|---|---|
| Tabs bar + tabs | Manual tab switching (state + visibility), params persist |
| model-row (Model dropdown + ⚙️ + ↺) | `<select>`/dropdown + ⚙️ (advanced modal) + ↺ (reset) |
| Steppers ± | `<div class=stepper>` with −/+ buttons + `<input type=number>` |
| W/H readonly | read-only spans (live calc) |
| AR dropdown, MP | `<select>` + stepper |
| Seed + 🎲 | stepper + checkbox (disables input) |
| LoRAs (all tabs that use them) | `LoRA config (JSON)` textarea in the advanced modal → sent to the API |
| Compare slider | two stacked `<img>` with `clip-path` via `--p` (ported from compare_images) |
| Video player | `<video>` from `/media` proxy |
| 📁 / 🔗 overlays + source URL field | 📁 opens file picker → `POST /api/upload`; 🔗 fills the field with `lastGeneratedUrl`; the field value is the tool's `image` |
| Prompt textarea | `#promptInput` textarea (bottom bar) |
| ✨🖌️🩹🔍🎬 buttons | bottom-bar action buttons → `fetch` to `/api/{tool}` |
| Advanced modal | HTML overlay, values stored per tab (`window.advancedValues`) |
| 🎨 dropdown (theme, server URL, media base URL) | settings menu → `GET/POST /api/settings` |
| Toast | `#toast` element |
| Result URL + 📋 | `#resultUrl` + copy button |

## 6. Mockup WIP placeholders → real behavior

| Element | In the mockup (WIP) | Real behavior (`app.html` + `server.py`) |
|---|---|---|
| 📁 Upload image | `showToast('File picker (WIP)')` | file picker → `POST /api/upload` → ComfyUI temp filename → fills the source field |
| 🔗 Use previous generation + URL field | `usePreviousSource()` fills the field with `lastGeneratedUrl` | same (works); the field value feeds the tool's `image` input (filename-vs-URL auto-detection, BACKEND.md §6); empty on generate → warning toast |
| ↺ Reset | `showToast('Parameters reset')` | real reset of that tab's parameters |
| Action buttons | fake URL (`ComfyUI_<ts>.png`) | real submission via `server.py` → `tools/*` → `comfy_client` |
| 🎨 dropdown (Server URL / Media base URL) | `showToast('... (WIP)')` | `GET /api/settings` (currently read-only; B4 will persist) |
| Advanced modal Save | `console.log` | stores per-tab values in `window.advancedValues` (LoRA config feeds the API) |

> Implementation note: the frontend is **not** Gradio — Gradio 6 could not
> reproduce the mockup's artisanal design (its shell fought the custom CSS).
> The mockup's HTML/CSS/JS is served directly via FastAPI (`server.py`).

## 7. Session state

- Each tab keeps its own parameter state and result independently; switching tabs does not reset anything.
- Session-global `lastGeneratedUrl`: the last generation's output URL, built as `{media_base_url}/view?filename=...&type=output`; **persists across tab switches** for chaining (🔗 fills the source URL field). The copyable result URL row is cleared on tab switch (per mockup).
- Reset (↺) restores defaults and clears that tab's output.
