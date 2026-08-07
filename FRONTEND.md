# Frontend Design — Comfy Tools

> **Source of truth: the code** (`templates/` + `static/`). `mockup.html` is the
> historical design template/spec and is **never edited for functionality**;
> the working UI has evolved beyond it (see the deviations listed in §8).
> If this document conflicts with the code, the code wins.
>
> Backend spec in `BACKEND.md`, implementation plan in `PLAN.md`.

## 1. Layout

Full-screen app (`100dvh`, no page scroll), in columns:

```
┌───────────────────────────────────────────────────────────────┐
│ Nav: [☰] [🖼️ Generate] [🖍️ Edit] [🔍 Upscale] [🎬 Video]     │ [toolbar por tab ▸] │
├───────────────────────────────┬───────────────────────────────┤
│  Output pane (flex 6)         │  Params pane (flex 4)         │
│  result / slider / video      │  per-tab controls + prompt    │
│  background #111122, centered │  scrollable, 280–480px        │
├───────────────────────────────┴───────────────────────────────┤
│  Bottom bar (portrait only): prompt + result URL row          │
└───────────────────────────────────────────────────────────────┘
```

- **Nav** (`templates/partials/nav.html`): ☰ hamburger (settings menu) at the
  left + 4 tab buttons. The right side holds `#tabsToolbar`, a per-tab
  toolbar rebuilt by `renderToolbar(tab)` in `static/js/tabs.js`:
  - **Generate**: Model dropdown (Krea 2, FLUX.2 Klein, Z-Image Turbo —
    default **Krea 2**) + ⚙️ + ↺
  - **Edit**: ⚙️ + ↺ (no model selector)
  - **Upscale**: ↺ only (SeedVR2 fixed, no ⚙️)
  - **Video**: Model dropdown (Wan 2.1, Wan 2.2) + ⚙️ + ↺
- **Landscape (≥1024px)**: the shared prompt block (textarea + action
  buttons + ✕ clear) and the result URL row are relocated into the active
  tab's params pane by `relayoutPrompt()` (`tabs.js`); the bottom bar is
  hidden. The URL row sits **below** the prompt, pinned to the pane bottom.
- **Portrait (<1024px)**: everything stays in the bottom bar (prompt +
  action buttons + URL row); tabs show icons only.

### Responsive

- **< 1024px**: tab text labels hidden (icons only); `.split` stacks to a
  column — output fills all available height, params below (compact
  padding 6px, gap 0, `flex:0 0 auto` so buttons never clip), prompt at the
  bottom bar. Generate params condense to a single wrapping row.
- **< 768px**: more compact paddings.

## 2. Tabs and per-tab action buttons

| Tab | Icon | Action buttons | Prompt visible |
|---|---|---|---|
| Generate | 🖼️ | `✨` (needs prompt) | Yes |
| Edit | 🖍️ | `🖌️ Edit` (needs prompt) + `🩹 Restore` (always active) | Yes |
| Upscale | 🔍 | `🔍` (no prompt needed) | No |
| Video | 🎬 | `🎬` (needs prompt) | Yes |

- Buttons that require a prompt are **disabled while the prompt is empty**
  and re-enabled as you type; a transparent click-catcher overlays the
  disabled button to show a "Please write a prompt first" toast
  (`updateActionButtons` in `api.js`, `btn-catcher` in `tabs.js`).
- `🩹 Restore` and `🔍 Upscale` never require a prompt.
- On tab switch: each tab's parameters **persist** (the DOM is not rebuilt);
  the copyable result URL row is **cleared** (📋 disabled). `lastGeneratedUrl`
  persists for chaining (🔗 fills the source field of Edit/Upscale/Video).
- Shortcuts: `Ctrl+1..4` switches tabs; `Esc` closes the modal.

## 3. Control inventory per tab

### 3.1 Generate 🖼️

Toolbar (nav): Model dropdown + ⚙️ + ↺.

| Model | auto steps | vae scale |
|---|---|---|
| Krea 2 (default) | 8 | 8 |
| FLUX.2 Klein | 8 | 64 |
| Z-Image Turbo | 10 | 16 |

**Params pane** (landscape two rows; portrait one wrapping row):
- Row 1: `↔️ W` readonly · `↕️ H` readonly · `📐 AR` dropdown (`2:3` default,
  `1:1`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`) · `🔲 MP` stepper (0.1–2.0,
  step 0.1, default 1.0)
- Row 2: `👣 Steps` stepper (1–15, auto-updates on model change) · `🌱 Seed`
  stepper + `🎲` (checked by default)

**LoRAs**: managed in the advanced modal via the inline row editor (see §4.7).

### 3.2 Edit ✏️

- **Output pane**: `📁` overlay (top-right) + collapsible URL field
  (bottom-left) + `🔗` button (bottom-right) over the **compare slider**
  (Original | Edited).
- **Toolbar**: ⚙️ + ↺ (no model selector; the model is fixed flux-2-klein).
- **Params**: `👣 Steps` stepper (1–15, default 6) · `🌱 Seed` stepper + `🎲`.

### 3.3 Upscale 🔍

- **Output pane**: `📁` + URL field + `🔗` over the **compare slider**
  (Original | Upscaled).
- **Toolbar**: ↺ only (no model, no ⚙️).
- **Params**: `🌱 Seed` stepper + `🎲` only. (Resolution/blend/color stay as
  workflow defaults — see BACKEND.md.)
- **Special layouts** (`tabs.js` `relayoutPrompt`):
  - **Portrait**: the bottom bar is hidden; the params pane is a row with
    the seed taking most of the width and the 🔍 button the rest; the result
    URL row wraps below full-width.
  - **Landscape**: 🔍 sits at the bottom-right of the params pane, just
    above the result URL row.

### 3.4 Video 🎬

- **Output pane**: `📁` + URL field + `🔗` over a real `<video>` player.
- **Toolbar**: Model dropdown (Wan 2.1 default, Wan 2.2) + ⚙️ + ↺.
- **Params**: `🎞️ Frames` stepper (81–161, step 4, default 81, snaps to
  4n+1) · `👣 Steps` stepper (4–10, default 4) · `🌱 Seed` stepper + `🎲`.
- **Negative prompt**: in the advanced modal (not the params pane).

## 4. Behaviors

### 4.1 Resolution calculation (Generate)

W/H derived from MP × AR × vae scale, live on change:

```
total_pixels = megapixels × 1_000_000
raw_w = √(total_pixels × w_ratio / h_ratio)
raw_h = raw_w × h_ratio / w_ratio
width  = max(vae_scale, round(raw_w / vae_scale) × vae_scale)
height = max(vae_scale, round(raw_h / vae_scale) × vae_scale)
```

- `vae_scale` per family (Krea 2=8, FLUX.2=64, Z-Image=16).
- Changing family sets steps automatically and recalculates W/H
  (`onModelFamilyChange` in `generate.js`). The init calls it so the default
  Krea 2 loads with steps 8 and vae-8 resolution.

### 4.2 Seed + 🎲 (all tabs)

- `🎲` checked (default) → seed input disabled. On submit, a random seed is
  **generated client-side** (`randomSeed()` in `api.js`, uint32) and **shown
  in the field**; that exact value is sent (not -1).
- Typing a value unchecks `🎲` and enables the input; the stepper ± disable
  along with the input (`:has(input:disabled)`).

### 4.3 Steppers

± component with centered input. Steps/Seed step 1; MP step 0.1; Frames
step 4 with 4n+1 snap and 81–161 clamp.

### 4.4 Compare slider (Edit and Upscale)

Two stacked `<img>` with `clip-path` via `--p`, draggable divider, labels
Original/Edited (or Upscaled) — ported from the reference compare_images.

### 4.5 Source image URL field (Edit/Upscale/Video)

Overlay at the bottom-left of the output pane; `🔗` at bottom-right fills it
with `lastGeneratedUrl`. Collapsible: **10% width when idle, expands to 50%
on focus or with content** (and shows a **✓ confirm button**); clicking the
field when it already has text **selects all of it** (`selectAllOnFocus`)
so it can be deleted or pasted over easily (first click selects all; later
clicks allow normal cursor placement); while a generation runs it fades
(opacity .25, `pointer-events:none`) via `setGenerating()`. The value feeds
the tool's `image` input (filename-vs-URL auto-detection, BACKEND.md §6);
empty on generate → warning toast.

**✓ Confirm** (`confirmSourceUrl` in `source.js`): validates the field value
server-side via `POST /api/check-image` (the browser cannot read
cross-origin headers — CORS is why this cannot be done client-side) and, if
it is really an image, shows it as a **preview filling the output pane**
(`source-preview`, dashed border + slightly dimmed to distinguish input
from output) and **collapses the field back to 10%** (`.collapsed`;
re-focusing the input expands it again). On failure it toasts the error
(HTTP status, content-type mismatch, unreachable URL…). The preview is
**also shown by 🔗** (`usePreviousSource` — which **flashes the field open
~1.5s then auto-collapses**, unless the user is editing the value) and by
**📁 upload** — any confirmed source becomes visible in the pane before
generating.

Filename-vs-URL follows the backend convention (`normalize_source`,
BACKEND.md §6): external URL → checked directly; anything else → treated as
a ComfyUI temp filename, checked against `{media_base}/view?type=temp`
(the same `source="temp"` decision `configure_image_node` makes).

### 4.6 🎨 settings menu (hamburger ☰)

- **Appearance**: `🌓 Toggle light / dark theme` — CSS custom properties
  swapped manually (no `prefers-color-scheme`), **persisted** to
  localStorage (`currentTheme` / `applyTheme` in `settings.js`).
- **ComfyUI Connection**: `🔌 Server URL` · `🖼️ Media base URL` — global
  settings, `GET/POST /api/settings`, persisted to `~/.gradio-comfy-tools.json`.

### 4.7 Advanced modal (⚙️)

Reachable from Generate, Edit and Video (toolbar ⚙️); Upscale has no gear.

| Tab | Fields |
|---|---|
| Generate | `Model name` (dropdown from `/models/diffusion_models`) · LoRA editor |
| Edit | LoRA editor |
| Upscale | *(none)* |
| Video (wan21) | `Diffusion model` (dropdown) · LoRA editor · `Negative prompt` (bottom) |
| Video (wan22) | `Diffusion model HIGH/LOW` (2 dropdowns) · LoRA editor HIGH/LOW (2) · `Negative prompt` (bottom, single) |

- **LoRA editor** (`modal.js`): inline rows of (LoRA name dropdown +
  strength text stepper ±0.05, default 1.0, up to 4) + "＋ Add LoRA". The
  JSON is derived on save (`advancedValues.lora` / `loraSets[path]`).
  Dropdowns are **filtered by the model's directory** (`zit/`, `flux2/`,
  `krea2/`, `wan21/`, `wan22/`) via `loraDirForContext()`; the label shows
  the name **without** the dir prefix, the value keeps the full path.
- **Model dropdowns** are populated from `/models/diffusion_models` (via
  `GET /api/diffusion-models`), with a "— default —" empty option.
- **wan22 dual path**: the modal is **wider** (`modal-wide`, 660px, 2-column
  grid) so HIGH/LOW fields sit side by side and LoRAs fit without scroll.
- **Per-version config store**: `advancedValues.video = { wan21: {...},
  wan22: {...} }` — switching versions preserves each one's own
  diffusion/LoRAs/negative (LoRAs are not cross-compatible).
- Footer `Cancel` + `Save`; Esc/✕ closes without saving.

### 4.8 Toast

`showToast()` (api.js) — floating bottom notifications.

### 4.9 Result URL

Shown in the URL row below the prompt (params pane in landscape, bottom bar
in portrait) with a 📋 copy button (disabled until a result exists).

## 5. How the code is organized

- **`templates/index.html`**: shell + Jinja2 includes + script/css links.
- **`templates/partials/`**: nav, settings_menu, tab_generate, tab_edit,
  tab_upscale, tab_video, bottom_bar, modal, toast, tooltip.
- **`static/css/`**: base, layout, components, responsive (split by role).
- **`static/js/`** (plain scripts, shared global scope, load order matters):
  state, storage, api, source, tabs, generate, edit, upscale, video,
  settings, modal, main.
- **`static/js/storage.js`**: persists user config in localStorage
  (`comfyTools.userConfig`): per-tab params, advancedValues, toolbar
  selections, theme. Saved on field change / modal save / theme toggle /
  toolbar change; restored on load.

## 6. Backend endpoints used by the UI

| Endpoint | Purpose |
|---|---|
| `GET /` | renders the UI |
| `GET /api/settings` | global settings (server/media URL, api key presence) |
| `POST /api/settings` | persist settings |
| `GET /api/loras` | LoRA names from ComfyUI (`/models/loras`) |
| `GET /api/diffusion-models` | diffusion model names (`/models/diffusion_models`) |
| `POST /api/generate` / `edit` / `upscale` / `video` | run the tools |
| `POST /api/upload` | upload image → ComfyUI temp filename |
| `POST /api/check-image` | validate a source value (URL or temp filename) is an image; returns `{ok, content_type\|error}` |
| `GET /media/{filename}` | same-origin proxy of results |

## 7. Session state

- Per-tab params persist across tab switches (DOM kept); now also persisted
  to localStorage across reloads.
- `lastGeneratedUrl` persists for chaining (🔗).
- `advancedValues` (per-tab advanced config) persists across modal opens and
  reloads (localStorage).

## 8. Deviations from the mockup (code is source of truth)

These are intentional, user-driven changes over the original `mockup.html`:

1. **Nav**: ☰ hamburger settings at top-left (was "🎨 Comfy Tools ▾" at
   right); per-tab model/gear/reset toolbar at right (was in the params
   pane); Edit/Upscale no longer show a model selector.
2. **Prompt**: in landscape it lives inside the params pane (fills the
   height, action buttons overlaid bottom-right, ✕ clear top-right); the
   bottom bar only holds it in portrait.
3. **Result URL row**: below the prompt (not a separate full-width bar in
   landscape).
4. **Advanced modal**: LoRA JSON textarea replaced by the visual row editor;
   model name/diffusion are dropdowns from ComfyUI; video varies by Wan
   version (wan22 dual high/low); per-version config store.
5. **Negative prompt**: moved into the advanced modal (video).
6. **Upscale**: special compact layouts (portrait: seed + 🔍 in the pane,
   no bottom bar; landscape: 🔍 above the URL row in the pane).
7. **Output fills the pane**: `width/height:100%` + `object-fit:contain`,
   8px padding.
8. **Source URL field**: collapsible 10%/50%, fades while generating.
9. **Buttons disabled with empty prompt** + click-catcher feedback.
10. **Random seed shown** in the field (client-generated, sent explicitly).
11. **localStorage persistence** of all user config.
12. Default image model is **Krea 2** (was Z-Image Turbo).
13. **Source preview**: the ✓ button next to the source URL field validates
the value and shows the image in the output pane; 🔗/📁 also preview the
source (dashed-border `.source-preview`). Added over the mockup.
