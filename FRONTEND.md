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
- **Landscape (≥1024px)**: the prompt block (textarea + action
  buttons + ✕ clear) and the result URL row are relocated into the active
  tab's params pane by `relayoutPrompt()` (`tabs.js`); the bottom bar is
  hidden. The URL row sits **below** the prompt, pinned to the pane bottom.
  The textarea is a **single shared element** relocated between tabs, but
  its VALUE is **independent per tool**: `promptsByTab` (state.js) stores
  one prompt per tab (generate/edit/video; Upscale has none) —
  `switchTab()` saves the outgoing tab's text and restores the incoming
  tab's, and `clearPrompt` (✕) clears only the active tab. Prompts are
  persisted to localStorage with the rest of the user config (storage.js)
  and restored on reload.
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
| Generate | 🖼️ | `🪄` (refine prompt) + `✨` (needs prompt) | Yes |
| Edit | 🖍️ | `🪄` (refine) + `🖌️ Edit` (needs prompt) + `🩹 Restore` (always active) | Yes |
| Upscale | 🔍 | `🔍` (no prompt needed) | No |
| Video | 🎬 | `🪄` (refine) + `🎬` (needs prompt) | Yes |

- Buttons that require a prompt are **disabled while the prompt is empty**
  and re-enabled as you type; a transparent click-catcher overlays the
  disabled button to show a "Please write a prompt first" toast
  (`updateActionButtons` in `api.js`, `btn-catcher` in `tabs.js`).
- `🩹 Restore` and `🔍 Upscale` never require a prompt.
- **🪄 prompt refiner**: refines the active tab's prompt via a llama-server
  OpenAI-compatible API (configured in the ☰ menu — Refiner URL + System
  prompt). In **landscape** it sits to the LEFT of the generate button in
  the button column (Generate/Edit/Video); in **portrait** it is a small
  overlay button at the bottom-right of the prompt textarea (analogous to
  the ✕ clear button, which is top-right). `refinePrompt()` replaces the
  textarea with the refined text and syncs the per-tab prompt store.
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

- **Output pane**: collapsible URL field (bottom-left) + 📁/🔗 buttons
  (bottom-right, 📁 just left of 🔗) over the **compare slider**
  (Original | Edited).
- **Toolbar**: ⚙️ + ↺ (no model selector; the model is fixed flux-2-klein).
- **Params**: `👣 Steps` stepper (1–15, default 6) · `🌱 Seed` stepper + `🎲`.

### 3.3 Upscale 🔍

- **Output pane**: 📁 + URL field + 🔗 (bottom-right, 📁 left of 🔗) over
  the **compare slider** (Original | Upscaled).
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

- **Output pane**: 📁 + URL field + 🔗 (bottom-right, 📁 left of 🔗) over a
  real `<video>` player.
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
The slider **fills the output pane** (width/height 100%) and the images use
`object-fit: contain` (like the Generate result) so both sides are fully
visible without cropping; the divider/handle follow `--p`.

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

**Video tab specifics**: the preview **replaces the video component** — the
mock placeholder (and any previous generated video) is hidden while the
source image fills the pane. When generation starts the image **recedes
behind the loading overlay** (dimmed, `.output-pane.busy .source-preview`;
the `.gen-spinner` overlay, z-index 10, sits above it) and is **removed when
the generation finishes** (`showResult`) to show the generated video. The
mock placeholder itself is **removed from the DOM** (not just hidden) when
the result lands, so it cannot be resurrected by `stopProgressPolling` and
push the `<video>` aside. In the other tabs the preview behaves as before.

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
  Dropdowns list the LoRAs **whose directory matches the model context
  first** (`zit/`, `flux2/`, `krea2/`, `wan21/`, `wan22/` via
  `loraDirForContext()`) and **every other LoRA after** — ComfyUI can
  resolve a unique name without its directory, so nothing is excluded. All
  matching is **separator-agnostic** (`/` and `\` — the server runs
  dual-boot Windows/Linux, so names arrive with either), the label shows
  the name **without** any dir prefix, and the value keeps the full path
  exactly as returned. A saved LoRA whose name no longer matches any
  available file shows a "— not available —" placeholder instead of
  silently becoming a different LoRA. By default **no LoRA is loaded**:
  empty/blank rows are dropped both when parsing saved configs and when
  saving (`parseLoraJson` / `loraSetsToJson`), and "＋ Add LoRA" only adds
  a row when the server actually has LoRAs.
- **Model dropdowns** are populated from `/models/diffusion_models` (via
  `GET /api/diffusion-models`), with a "— default —" empty option.
- **wan22 dual path**: the modal is **wider** (`modal-wide`, 760px) and the
  HIGH/LOW paths are **vertical sections** — each a titled box (`.lora-section`
  + `.lora-section-title`) holding its own `Diffusion model` dropdown and
  `LoRA config` editor, stacked top-to-bottom with the section header as the
  separator (inner labels do NOT repeat HIGH/LOW). The negative prompt spans
  the full width at the bottom.
- **Per-version config store**: `advancedValues.video = { wan21: {...},
  wan22: {...} }` — switching versions preserves each one's own
  diffusion/LoRAs/negative (LoRAs are not cross-compatible).
- Footer `Cancel` + `Save`; Esc/✕ closes without saving.

### 4.8 Toast

`showToast()` (api.js) — floating bottom notifications.

### 4.9 Result URL + live progress

Shown in the URL row below the prompt (params pane in landscape, bottom bar
in portrait) with a 📋 copy button (disabled until a result exists).

**While a generation runs**, the same row shows **live progress** instead of
the URL (`startProgressPolling` in `api.js`): it polls `GET /api/progress`
every second and paints the current stage — `⏳ Queued…`, then `⚙️ <node
_title> <value>/<max>` (e.g. `⚙️ SamplerCustomAdvanced 4/8`) as ComfyUI
moves node to node. On success the URL replaces the progress text; on error
the row is cleared (the error toast appears as before).

**Live per-step preview** (Generate, Edit and Video): while the job runs,
`/api/progress` also carries the latest latent decode (`active.preview`, a
JPEG data URL). `startProgressPolling` paints it as an `<img class="preview-live">`
inside the output pane of the tab that started the generation, and ONLY
while that tab is active — switching tabs mid-generation keeps capturing
server-side but stops painting; coming back resumes with the latest frame.
While painted it hides (and restores on cancel) the placeholder / previous
result / source preview / compare slider / video mock so it fills the pane
and stays centered; the spinner stays on top (`.busy` z-index).
`stopProgressPolling` removes it, and `showResult`/`clearPane` drop it too so
the final result replaces the preview. The preview is ephemeral: it is
intentionally lost on cancel and never shown after the job settles.

**⏹ Cancel**: while a generation runs, the (disabled) 📋 copy button is
**replaced by a ⏹ stop button** (`cancelGeneration` in `api.js`). Clicking it
calls `POST /api/cancel` (backend: `POST /interrupt` to stop the running
prompt + `POST /queue` `delete` for the pending one, and marks the job done)
and aborts the in-flight fetch, so the UI settles immediately (toast
`Cancelled`). When the generation settles — success or cancel — the copy
button comes back (enabled once a result URL is shown, disabled otherwise).

## 5. How the code is organized

- **`templates/index.html`**: shell + Jinja2 includes + script/css links.
- **`templates/partials/`**: nav, settings_menu, tab_generate, tab_edit,
  tab_upscale, tab_video, bottom_bar, modal, toast, tooltip.
- **`static/css/`**: base, layout, components, responsive (split by role).
- **`static/js/`** (plain scripts, shared global scope, load order matters):
  state, storage, api, source, tabs, generate, edit, upscale, video,
  gallery, settings, modal, main.
- **`static/js/storage.js`**: persists user config in localStorage
  (`comfyTools.userConfig`): per-tab params, advancedValues, toolbar
  selections, theme. Saved on field change / modal save / theme toggle /
  toolbar change; restored on load.

## 6. Backend endpoints used by the UI

| Endpoint | Purpose |
|---|---|
| `GET /` | renders the UI |
| `GET /api/settings` | global settings (server/media URL, api key presence) |
| `GET /api/progress` | live progress of the most recent job (`{active: {stage, node, node_title, value, max, preview?} | null}` — `preview` is the latest per-step latent decode as a `data:image/jpeg;base64,…` URL, only while the job runs) |
| `POST /api/cancel` | cancel the most recent job (interrupt running + delete pending) |
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

### 7.1 Galleries (`gallery.js`)

Two separate session-scoped galleries (in-memory; not persisted):

- **`window.galleryGenerated`** — the Generate lightbox history. Every
  generation joins it via `addGeneratedEntry`. Transformations:
  - **Edit ✏️ / Restore 🩹** `appendTransformedEntry` — APPEND a new entry
    (the original image stays): the transformation's own text is what the
    💬 Show prompt modal shows; if the source was a gallery image, its
    prompt is kept as `originalPrompt` and shown on badge hover
    ("Edited"/"Restored" → `#galleryBadgeHint`, a grey translucent panel
    below the badge, via `.gallery-badge.show:hover +
    .gallery-badge-hint:not(.empty)`). Restore may have no prompt — the
    Show prompt button is hidden, but the hover still shows the source's
    prompt. Edits of non-gallery sources (uploads / external URLs) append
    with no hover hint.
  - **Upscale 🔍** `addTransformedEntry` — REPLACES the source entry in
    place: the generation prompt stays as the Show prompt content, badge
    "Upscaled", no hover hint (an upscale has no transformation prompt).
  - **Prompt display**: the prompt is NOT a bottom caption anymore. A 💬
    **Show prompt** button sits bottom-center, visible only when the entry
    has a prompt; clicking it opens a **semi-transparent modal**
    (`#galleryPromptModal`) with the full prompt (white-space: pre-wrap,
    textContent — never innerHTML) at a **device-appropriate font size**
    (`font-size: clamp(15px, 2vw + 1vh, 26px)` — ~16px on phones, ~20px on
    tablets, capped ~26px on large screens; title and line-height use the
    same vw+vh formula). The modal closes on ✕, backdrop click, Escape,
    navigation (‹ › / ←/→) and gallery close — while it is open, Escape
    closes only the modal and gallery navigation is suspended so the shown
    prompt never goes stale.
  - Identification by ComfyUI filename (`filenameFromUrl` handles
    `/media/..`, `/view?filename=..`).
- **`window.galleryComparisons`** — the Edit/Upscale ⛶ compare gallery:
  edited/restored/upscaled before/after pairs (`addCompareEntry`, deduped by
  the AFTER image URL). `collectCompareEntries()` merges the registry with
  any `[data-gallery="1"]` sliders still in the DOM (reload fallback).
- The overlay (`#galleryOverlay`) opens fullscreen: lightbox for Generate
  (big image + 💬 Show prompt button + badge/hover + ‹ › + N/M counter
  bottom-right + download top-left + close ✕ top-right), compare slider for
  Edit/Upscale (interactive before/after). The N/M counter is always
  visible; ‹ › only with more than one entry. Escape/✕/backdrop close;
  ←/→ navigate.
- Video results are only COLLECTED (`window.galleryVideos`) for a future
  video gallery — not navigable yet.

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
