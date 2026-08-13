# Frontend Design — Comfy Tools

> **Source of truth: the code** (`templates/` + `static/`). `docs/mockup.html` is the
> historical design template/spec and is **never edited for functionality**;
> the working UI has evolved beyond it (see the deviations listed in §8).
> If this document conflicts with the code, the code wins.
>
> Backend spec in `docs/BACKEND.md`, implementation plan in `docs/PLAN.md`.

## 1. Layout

Full-screen app (`100dvh`, no page scroll), in columns:

```
┌───────────────────────────────────────────────────────────────┐
│ Nav: [☰] [🖼️ Generate] [🖍️ Edit] [🔍 Upscale] [🎬 Video]     │ [toolbar por tab ▸] │
├───────────────────────────────┬───────────────────────────────┤
│  Output pane (flex 6)         │  Params pane (flex 4)         │
│  result / slider / video      │  prompt (fills the pane) +    │
│  background #111122, centered │  parameter chips (📏/👣/🎞️)   │
├───────────────────────────────┴───────────────────────────────┤
│  Bottom bar (portrait only): prompt + result URL row          │
└───────────────────────────────────────────────────────────────┘
```

- **Nav** (`templates/partials/nav.html`): ☰ hamburger (settings menu) at the
  left + 4 tab buttons (in **landscape**). The right side holds
  `#tabsToolbar`, a per-tab toolbar rebuilt by `renderToolbar(tab)` in
  `static/js/tabs.js`:
  - **Generate**: Model dropdown (Krea 2, FLUX.2 Klein, Z-Image Turbo —
    default **Krea 2**) + ⚙️ + ↺
  - **Edit**: ⚙️ + ↺ (no model selector)
  - **Upscale**: ↺ only (SeedVR2 fixed, no ⚙️)
  - **Video**: Model dropdown (Wan 2.1, Wan 2.2) + ⚙️ + ↺
- **Portrait-only tabs dropdown**: on vertical displays (<1024px) the nav
  bar is too small for four tab buttons, so they condense into a dropdown
  (`#tabsDropdown`): the trigger shows the ACTIVE tab as an **icon only**
  (no letters — they appear only when the menu opens) + a ▾ caret, and the
  menu lists all four (icon + label, active one highlighted). The
  inline `.tab-btn` stay in the DOM (hidden by `responsive.css`; landscape
  needs them and `switchTab` keeps marking the active one).
  `updateTabsDropdown()` (called at the end of `switchTab`) syncs the
  trigger icon and the menu highlight; `toggleTabsDropdown` /
  `closeTabsDropdown` manage open/close. The menu is `position: fixed` and
  JS anchors it under the trigger on open (the nav bar's
  `overflow-x: auto` would clip an absolutely-positioned descendant);
  clicking outside closes it, and it is force-closed when crossing the
  breakpoint.
- **Landscape (≥1024px)**: the prompt block (textarea with its ✕ clear +
  the parameter chips 📏/👣/🎞️ bottom-left and the ACTION chips 🪄/🩹/✨
  bottom-right — all INSIDE the field) and the result URL row are
  relocated into the active
  tab's params pane by `relayoutPrompt()` (`tabs.js`); the bottom bar is
  hidden. The URL row sits **below** the prompt, pinned to the pane bottom.
  There is **one INDEPENDENT textarea per tab** (generate/edit/video;
  Upscale has none) inside the shared `.prompt-input-wrap` — each field
  keeps its own value permanently, so prompts can never mix.
  `switchTab()` only toggles which field is visible (`.prompt-input.active`),
  and `clearPrompt` (✕) clears only the active tab. `promptsByTab`
  (state.js) mirrors the fields for localStorage persistence (storage.js),
  restored once at startup.
- **Portrait (<1024px)**: everything stays in the bottom bar (prompt +
  URL row); the four tab buttons condense into the tabs
  dropdown (icon + label of the active tab as the trigger). The prompt is a
  **compact single-line field** that CONTAINS the action chips (🩹/✨
  bottom-right, horizontal — the user can generate WITHOUT opening the
  modal); the ✕ clear, the 🪄 refine chip (the `.btn-col` one AND the
  `.prompt-actions` overlay) and the parameter chips are
  **hidden in the bar** — 🪄 exists ONLY inside the prompt modal.
  **Tapping the field opens a fullscreen
  prompt modal**
  (`#promptModal`): the same `.prompt-input-wrap` is relocated into it
  (`.modal-mode`) with a large textarea and its overlay actions: **✕ clear
  top-right** (recovered — it was hidden by the compact-bar rule because
  the modal lives inside `.bottom-bar`), and at the **bottom-right three
  pills larger than the chips**: **🪄 refine** + **🩹 restore** (Edit only,
  right of 🪄) + **✨ direct generation**
  (the active tab's action: ✨ Generate / 🖌️ Edit / 🎬 Video — `promptModalGenerate`
  validates the prompt, closes the modal and runs the tool; `promptModalRestore`
  runs the restore directly; the ✨ uses the accent background like the
  buttons outside, while 🪄/🩹 stay neutral pills). While a
  generation runs the matching modal button becomes the ⏹ stop button like
  the toolbar buttons, and the ✕ is disabled). The wrap's own `.btn-col`
  is hidden inside the modal (`.prompt-input-wrap.modal-mode .btn-col`).
  The chips (📏/👣/🎞️) also
  appear inside the modal
  (bottom-left). A header holds a ✓ Done button to close.
  `openPromptModal`/`closePromptModal` (`tabs.js`); closed when crossing
  the breakpoint (`main.js`) or tapping outside the prompt field. The modal
  **fits the visible area when the mobile keyboard opens**: the keyboard
  does not resize `position: fixed` elements, so `fitPromptModal()`
  listens to `window.visualViewport` resize/scroll and sets the modal's
  top+height to the real viewport (cleared on close).

### Responsive

- **< 1024px**: the inline tab buttons are hidden and the **tabs dropdown**
  takes their place (icon-only trigger + ▾ caret; the labels appear only
  inside the menu); the nav toolbar's **Model** label is hidden too
  (landscape keeps it). `.split` stacks to a
  column — output fills all available height, prompt at the
  bottom bar. The Generate/Edit/Video **params panes are hidden** (their
  controls live in the prompt chips → fullscreen prompt modal); Upscale
  keeps its params pane (seed + 🔍 + URL row).
- **< 768px**: more compact paddings.

## 2. Tabs and per-tab action buttons

| Tab | Icon | Action buttons | Prompt visible |
|---|---|---|---|
| Generate | 🖼️ | `🪄` (refine prompt) + `✨` (needs prompt) | Yes |
| Edit | 🖍️ | `🪄` (refine) + `🩹 Restore` (always active) + `🖌️ Edit` (needs prompt) — order 🪄 · 🩹 · 🖌️ | Yes |
| Upscale | 🔍 | `🔍` (no prompt needed) | No |
| Video | 🎬 | `🪄` (refine) + `🎬` (needs prompt) | Yes |

- Buttons that require a prompt are **disabled while the prompt is empty**
  and re-enabled as you type; a transparent click-catcher overlays the
  disabled button to show a "Please write a prompt first" toast
  (`updateActionButtons` in `api.js`, `btn-catcher` in `tabs.js`).
- **During a generation** (any tool): the prompt textarea is **locked**
  (typing blocked, dimmed), the 🪄 refine buttons and every OTHER action
  button are disabled — including the complementary 🖌️/🩹 in Edit (running
  an edit blocks the restore button and vice versa) and the Upscale buttons
  wherever they sit. The action button that STARTED the generation
  transforms into the ⏹ **stop** button (see §4.9). Clicking a disabled
  action shows the "Generation in progress…" toast (click-catcher swap).
  The lock is released when the request settles (success, error, cancel)
  and is **re-asserted on tab switch** mid-generation (`switchTab` rebuilds
  `#btnCol` with fresh buttons — `setGeneratingUi`/`applyGenerationLock` in
  `api.js`).
- `🩹 Restore` and `🔍 Upscale` never require a prompt.
- **🪄 prompt refiner**: refines the active tab's prompt via a llama-server
  OpenAI-compatible API (configured in the ☰ menu — Refiner URL + System
  prompt). In **landscape** it is a chip at the
  bottom-right of the prompt field, before the generate chip (Generate/Edit/Video);
  in **portrait** it is a pill in
  the prompt modal's bottom-right actions (next to 🩹/✨). `refinePrompt()`
  streams the refined text live into the textarea via **SSE** (`POST
  /api/refine-prompt` with `stream:true`, read with fetch's ReadableStream),
  showing a live tok/s estimate in the
  result URL row and the final `✨ tokens · tok/s avg` stats on completion;
  cancel (⏹) restores the original prompt. On completion it syncs the
  per-tab prompt store.
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

**Parameter chips** (overlaid on the prompt textarea — the params pane is
empty and the prompt fills it; see also deviation 14):
- **📏 Dimensions** — shows the current **aspect ratio** (e.g. `2:3`). Its
  popover holds `↔️ W` readonly · `↕️ H` readonly · `📐 AR` dropdown
  (`2:3` default, `1:1`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`) · `🔲 MP`
  stepper (0.1–2.0, step 0.1, default 1.0).
- **👣 Steps & seed** — shows `steps · 🎲` while the seed is random; when
  the seed is **fixed**, the separator and the dice disappear (steps only)
  — that is the visual cue. Its popover
  holds the `👣 Steps` stepper (1–15, auto-updates on model change) and the
  `🌱 Seed` stepper + `🎲` (checked by default).

**LoRAs**: managed in the advanced modal via the inline row editor (see §4.7).

### 3.2 Edit ✏️

- **Output pane**: collapsible URL field (bottom-left) + 📁/🔗 buttons
  (bottom-right, 📁 just left of 🔗) over the **compare slider**
  (Original | Edited).
- **Toolbar**: ⚙️ + ↺ (no model selector; the model is fixed flux-2-klein).
- **Params**: a single **👣 chip** over the prompt textarea (same design as
  Generate): shows `steps · 🎲` (steps only when the seed is fixed — the
  separator and dice disappear). Its popover holds the `👣 Steps` stepper
  (1–15, default 6) and the `🌱 Seed` stepper + `🎲`.

### 3.3 Upscale 🔍

- **Output pane**: 📁 + URL field + 🔗 (bottom-right, 📁 left of 🔗) over
  the **compare slider** (Original | Upscaled).
- **Toolbar**: ↺ only (no model, no ⚙️).
- **Params**: the `🌱 Seed` stepper + `🎲` directly in the params pane —
  Upscale has NO prompt textarea, so it does not use the chip design and
  keeps its control as before. (Resolution/blend/color stay as
  workflow defaults — see BACKEND.md.)
- **Special layouts** (`tabs.js` `relayoutPrompt`):
  - **Portrait**: the bottom bar is hidden; the params pane is a row with
    the seed taking most of the width and the 🔍 button the rest; the
    result URL row wraps below full-width.
  - **Landscape**: 🔍 sits at the bottom-right of the params pane, just
    above the result URL row.

### 3.4 Video 🎬

- **Output pane**: 📁 + URL field + 🔗 (bottom-right, 📁 left of 🔗) over a
  **custom video player** (`static/js/player.js`, replaces the native
  controls): autoplay muted loop; bottom-centered **three identical
  circular buttons** (same size + style, hover accent — the icons are
  inline SVG, so no emoji/font-glyph differences across platforms):
  play/pause (icon **follows the playback state** — pause while playing,
  play while paused, synced via `play`/`pause`/`ended`, so a
  browser-blocked autoplay shows play from the start), stop (pauses and
  resets the video to the beginning) and more options (⋮ — opens the
  per-player options menu: a **Speed entry** (label + current value +
  `›` caret) and a **Loop checkbox** (ON by default; unchecked
  the video stops at the end — the ▶/⏸ icon re-syncs via `ended`). The
  Speed entry is styled like a native menu row and sits ABOVE the Loop
  checkbox. On DESKTOP LANDSCAPE, hovering it opens a submenu
  to the RIGHT of the menu — like native submenus — with NATIVE radio
  buttons for the standard player speeds (`2× 1.75× 1.5× 1.25× 1× 0.75×
  0.5× 0.25×`, largest first, significant decimals; `1×` checked by
  default; selecting applies `v.playbackRate` and updates the row's value).
  The submenu is aligned so the **1× entry sits at the same height as the
  Speed row** (the fixed reference even when another speed is selected),
  TOUCHING the menu's right edge (no gap), and falls back to the LEFT when
  it would overflow the window. Row + submenu form one hover zone: leaving
  either starts a 150ms grace timer (like the gallery prompt panel) so
  crossing the seam between them never closes the submenu; entering either
  cancels it. Leaving the WHOLE set (main menu + submenu) closes BOTH
  (the submenu is a DOM descendant, so crossing from menu to submenu never
  fires it — only leaving everything does, same grace timer). On PORTRAIT / narrow screens (<1024px) there is no room
  beside the menu, so the Speed click switches to **drill-down mode**: the
  submenu REPLACES the main menu and the whole panel is CENTERED on screen
  (`position: fixed`, `max-height` + scroll so every option is reachable
  on short screens; the `← Speed` back header returns to the main menu);
  choosing a speed (or ←) closes the submenu and
  the main menu reappears. The menu is styled like the
  prompt chips popover and is a CHILD of the player wrap, so it stays
  visible inside the fullscreen video gallery; it opens upward from the
  controls and closes on outside click / Escape (Escape closes ONLY the
  menu first — the gallery overlay closes on the NEXT Escape) with
  PROGRESSIVE dismiss, like native menus: an open speed submenu is the
  TOP level, so an outside click/Escape closes ONLY it (the main menu
  stays); the next outside click/Escape closes the main menu. With a menu
  open, clicking on the video itself (outside the menus) dismisses the
  top level WITHOUT toggling play/pause — the click is treated as
  dismissing the menu, not as a video interaction.
  Session-only per player: every new player starts with loop ON and 1×
  (navigating the gallery rebuilds the player, resetting the options); a
  thin accent progress line at the very bottom edge
  (**2px**, rAF-driven, always visible) that is also a **scrubber**:
  hover (or touch on mobile) doubles the line height (2→**4px**) and
  reveals a circular accent
  thumb + a shaded tooltip with the position in tenths of a second
  (seconds, e.g. `3.4s`); dragging (or tapping) the bar **seeks the video,
  playing or
  paused** — the hit area is 12px tall, flush with the pane's bottom
  overlay buttons so they stay fully clickable; the drag uses pointer
  events + capture with `touch-action: none` (no page scroll); a
  **fullscreen overlay button ⛶ top-right** (same style as the
  compare sliders' button — `.output-overlay-btn.top-right`, SVG icon)
  that toggles real browser fullscreen and shows the exit icon in the
  same spot while in
  fullscreen; **single click anywhere on the video toggles play/pause,
  double click toggles fullscreen** (controls excluded); **leaving the
  Video tab pauses a playing video** (`pauseActiveVideo()`, called from
  `switchTab`) so it doesn't keep consuming resources in the background.
  The player is created with `noFullscreenBtn=true` in the pane (the
  pane's own top-right ⛶ opens the VIDEO GALLERY) AND in the gallery
  overlay's video mode (the overlay is already fullscreen and the
  gallery's ✕ occupies the same top-right corner) — the ⛶ button only
  exists where there is no competing button.
- **Toolbar**: Model dropdown (Wan 2.1 default, Wan 2.2) + ⚙️ + ↺.
- **Params**: two chips over the prompt textarea — **🎞️ Frames** (shows
  the frame count, popover with the 81–161 stepper, step 4, 4n+1 snap) and
  **👣 Steps & seed** (same label rules as Generate; popover with the
  `👣 Steps` stepper 4–10 default 4 and the `🌱 Seed` stepper + `🎲`).
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
The slider **fills the output pane** (width/height 100%, `min-height: 200px`
so it never collapses in portrait; the portrait pane also gets
`min-height: 40vh`) and the images use `object-fit: contain` (like the
Generate result) so both sides are fully visible without cropping; the
divider/handle follow `--p`. **The BEFORE image goes through the same
same-origin `/media` proxy as the results** (`beforeProxyUrl()` in
`source.js` resolves any source — external URL, `/media/..`, `{base}/view?..`,
bare temp filename — to a `/media` URL; the raw ComfyUI host is never fed
to an `<img>`, which is what left the original black on devices that cannot
reach that hostname). **Drag is delegated** (`setupCompareSlider` in
`main.js`) and works for the pane sliders AND the fullscreen gallery
slider (`#gallerySlider`). The AFTER label follows the mode
(Edited/Restored) — not hardcoded.

### 4.5 Source image URL field (Edit/Upscale/Video)

Overlay at the bottom-left of the output pane; `🔗` at bottom-right fills it
with `lastGeneratedUrl`. Collapsible: **10% width when idle, expands to 50%
on focus or with content** (and shows a **✓ confirm button**); **on mobile
(<768px) it is collapsed by default** — the idle overlay is a minimal 10%
sliver and only expands while focused (the expand-on-content rule is
overridden, so a saved value never keeps it expanded on phones; it snaps
back to 10% when focus leaves). Clicking the field when it already has
text **selects all of it** (`selectAllOnFocus`) so it can be deleted or
pasted over easily (first click selects all; later clicks allow normal
cursor placement); while a generation runs it fades (opacity .25,
`pointer-events:none`) via `setGenerating()`. **On mobile the field is
kept above the keyboard**: when it is focused, `keepSourceFieldVisible`
(`source.js`) calls `scrollIntoView` and re-rolls it on every
`visualViewport` resize/scroll (the layout viewport does not shrink for
the keyboard — only the visual one does, so the field at the bottom of
output pane would otherwise be covered). Only on <768px and only for the
focused field. The value feeds the tool's `image` input
(filename-vs-URL auto-detection, docs/BACKEND.md §6); empty on generate →
warning toast.

**✓ Confirm** (`confirmSourceUrl` in `source.js`): validates the field value
server-side via `POST /api/check-image` (the browser cannot read
cross-origin headers — CORS is why this cannot be done client-side) and, if
it is really an image, shows it as a **preview filling the output pane**
(`source-preview`, slightly dimmed to distinguish input from output —
no frame) and **collapses the field back to 10%** (`.collapsed`;
re-focusing the input expands it again). **Pressing Enter inside the field
does the same as clicking ✓** (same `confirmSourceUrl`, with the same
in-flight guard: a second Enter while the check runs is ignored). On
failure it toasts the error
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
docs/BACKEND.md §6): external URL → checked directly; anything else → treated as
a ComfyUI temp filename, checked against `{media_base}/view?type=temp`
(the same `source="temp"` decision `configure_image_node` makes).

### 4.6 🎨 settings menu (hamburger ☰)

- **Appearance**: `🌓 Toggle light / dark theme` — CSS custom properties
  swapped manually (no `prefers-color-scheme`), **persisted** to
  localStorage (`currentTheme` / `applyTheme` in `settings.js`).
- **ComfyUI Connection**: `🔌 Server URL` · `🖼️ Media base URL` — global
  settings, `GET/POST /api/settings`, persisted to `~/.gradio-comfy-tools.json`.
- **Reset everything** (🗑️, bottom of the menu): wipes ALL user data the
  app saved in this browser — settings, prompts, parameter values, history
  and galleries — after a confirmation dialog written in plain language
  (no internal jargon), then reloads the page so the UI starts clean.
  `resetAllUserData()` in `storage.js` (removes the localStorage key,
  resets the in-memory registries and reloads).

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
  strength stepper ±0.01 with hold-to-accelerate (any real value, default
  1.0, up to 4) + "＋ Add LoRA". The
  JSON is derived on save (`advancedValues.lora` / `loraSets[path]`).
  In **portrait (<1024px)** the row narrows the dropdown (`max-width: 60%`,
  name truncates visually, full value kept) and locks the stepper + remove
  to their own widths — the native `<select>` won't shrink below its
  content width and the modal-wide `input[type=text] { width: 100% }`
  would otherwise expand the strength field, overlapping the −/+ buttons.
  Dropdowns list ONLY the LoRAs **whose directory matches the model
  context** (`zit/`, `flux2/`, `krea2/`, `wan21/`, `wan22/` via
  `loraDirForContext()`) — a STRICT filter, not a priority sort: LoRAs
  trained for another model family are excluded entirely (injecting them
  would silently produce garbage). All
  matching is **separator-agnostic**: ComfyUI Windows returns paths with
  backslashes that the JSON body serializes as `\\` (escaped), Linux with
  forward slashes. A tiny `PurePosixPath` shim (`modal.js`) normalizes
  any run of `/` and `\` to `/` (via `purePath`), so the directory
  matching works identically on both OSes. The label shows
  the name **without** any dir prefix (all listed are in the same dir),
  and the value keeps the full path
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
in portrait) with a 📋 copy button (disabled until a result exists). The row
**always reflects the image/video currently shown in the pane** — also when
navigating with the pane ‹ › arrows or switching tabs: every render path
(finalize of a generation, `paneNav`/`renderPane`, `restoreTabResult`,
reset/trash) calls `syncResultUrl(tab, entry)` (gallery.js), which paints the
entry's direct URL (or rebuilds it from the display src via `fullComfyUrl`
for compare entries) and clears the row when the pane is empty. It only
paints when the tab is the ACTIVE one — the row is shared across tabs.
The row truncates long URLs with ellipsis; the **full URL is always the
one copied** by 📋 (it reads the row's exact text) and is also available
on hover (the row carries it as `title`). `copyResultUrl` (api.js) is
robust on plain-http LAN (where `navigator.clipboard` does not exist): it
falls back to a hidden textarea + `execCommand('copy')` and always shows
explicit feedback (previously a missing API threw silently and the user
pasted a STALE clipboard URL — not the one shown).

The ↺ resets restore parameters and clear the pane (and the URL row), but
**never touch the galleries** — emptying those is exclusively the 🗑️ trash
button (the old clearPane registry-drop was removed).

**While a generation runs**, the same row shows **live progress** instead of
the URL (`startProgressPolling` in `api.js`): the backend PUSHES every job
update over the **`/ws/progress` WebSocket** (opened on job start) and the
page paints the current stage — `⏳ Queued…`, then `⚙️ <node_title>
<value>/<max>` (e.g. `⚙️ SamplerCustomAdvanced 4/8`) as ComfyUI moves node
to node. The classic 1s polling of `GET /api/progress` is kept ONLY as an
automatic fallback when the WS is unavailable (`wsProgressFailed` in
api.js) — same payload shape, same painter. On success the URL replaces the
progress text; on error the row is cleared (the error toast appears as
before).

**Live per-step preview** (Generate, Edit and Video): while the job runs,
the `/ws/progress` push also carries the latest latent decode
(`active.preview`, a JPEG data URL). `startProgressPolling` paints it as an
`<img class="preview-live">`
inside the output pane of the tab that started the generation, and ONLY
while that tab is active — switching tabs mid-generation keeps capturing
server-side but stops painting; coming back resumes with the latest frame.
While painted it hides (and restores on cancel) the placeholder / previous
result / source preview / compare slider / video mock / video player so it
fills the pane and stays centered; the spinner stays on top (`.busy` z-index).
`stopProgressPolling` removes it, and `showResult`/`clearPane` drop it too so
the final result replaces the preview. The preview is ephemeral: it is
intentionally lost on cancel and never shown after the job settles.

**⏹ Cancel (by transformation)**: while a generation runs, the action
button that started it — ✨ / 🖌️ / 🩹 / 🔍 / 🎬 — **transforms into the ⏹
stop button** (same pattern as the 🪄 → ⏹ refine button: glyph, title and
onclick are swapped and stashed on the element, `makeStopButton` /
`restoreStopButton` in `api.js`). There is no separate stop button in the
URL row anymore (the small corner ⏹ was removed). Clicking the transformed
⏹ calls `cancelGeneration()` (`POST /api/cancel` — backend:
`POST /interrupt` to stop the running prompt + `POST /queue` `delete` for
the pending one, and marks the job done) and aborts the in-flight fetch,
so the UI settles immediately (toast `Cancelled`). The 📋 copy button is
HIDDEN while the generation runs (the row shows the live progress text)
and comes back when the generation settles (enabled once a result URL is
shown, disabled otherwise). The transform survives tab switches
mid-generation (`switchTab` re-asserts the lock with `applyGenerationLock`
and re-transforms the trigger button).

- The stop-transformed trigger is ENABLED, so the click-catcher overlay
  must not sit on top of it — `.btn-col.generating .btn-wrap:has(.btn-generate:not(:disabled))
  .btn-catcher { display: none }` (the catcher only overlays DISABLED
  buttons; a click on the ⏹ reaches it directly). In the portrait prompt
  modal, the button that matches the trigger becomes the ⏹ (🩹 restore →
  🩹; ✨/🖌️/🎬 → ✨) and the other modal action stays disabled.

## 5. How the code is organized

- **`templates/index.html`**: shell + Jinja2 includes + script/css links.
  All assets load with a `?v=<hash>` cache-buster derived from the static
  files' mtimes (`server.py` `ASSET_VERSION`), so a reload ALWAYS fetches
  the current JS/CSS — a stale browser tab can never keep running old code
  after a deploy.
- **`templates/partials/`**: nav, settings_menu, tab_generate, tab_edit,
  tab_upscale, tab_video, bottom_bar, modal, gallery_overlay, toast, tooltip.
- **`static/css/`**: base, layout, components, responsive (split by role).
- **`static/js/`** (plain scripts, shared global scope, load order matters):
  state, storage, api, player, refine, source, tabs, generate, edit, upscale,
  video, gallery, restore, settings, modal, main.
- **`static/js/storage.js`**: persists user config in localStorage
  (`comfyTools.userConfig`): per-tab params, advancedValues, toolbar
  selections, per-tab prompts, theme AND the galleries (`generated` /
  `videos` / `comparisons`). Saved on field change / modal save / theme toggle /
  toolbar change / gallery mutation; restored on load.

## 6. Backend endpoints used by the UI

| Endpoint | Purpose |
|---|---|
| `GET /` | renders the UI |
| `GET /health` | server + ComfyUI health (version, base URL) |
| `GET /api/settings` | global settings (server/media URL, api key presence) |
| `GET /api/progress` | live progress of the most recent job (`{active: {stage, node, node_title, value, max, preview?} | null}` — `preview` is the latest per-step latent decode as a `data:image/jpeg;base64,…` URL, only while the job runs) |
| `GET /api/last-result` | URL of the last COMPLETED job (recovery when the frontend's in-flight fetch was aborted — background tab) |
| `POST /api/cancel` | cancel the most recent job (interrupt running + delete pending) |
| `POST /api/settings` | persist settings |
| `GET /api/loras` | LoRA names from ComfyUI (`/models/loras`) |
| `GET /api/diffusion-models` | diffusion model names (`/models/diffusion_models`) |
| `POST /api/generate` / `edit` / `upscale` / `video` | run the tools |
| `POST /api/refine-prompt` | 🪄 refine a prompt via the llama-server refiner (OpenAI-compatible; `stream:true` → SSE of deltas, `system_prompt` override) |
| `POST /api/upload` | upload image → ComfyUI temp filename |
| `POST /api/check-image` | validate a source value (URL or temp filename) is an image; returns `{ok, content_type\|error}` |
| `GET /api/media-exists` | lightweight HEAD/206 probe that a result file still exists on ComfyUI (persisted gallery pruning) |
| `GET /media/{filename}` | same-origin **streaming** proxy of results (honors the `Range` header — the `<video>` element can seek/buffer progressively; returns 206 for partials) |

## 7. Session state

- Per-tab params persist across tab switches (DOM kept); now also persisted
  to localStorage across reloads.
- `lastGeneratedUrl` persists for chaining (🔗).
- `advancedValues` (per-tab advanced config) persists across modal opens and
  reloads (localStorage).
- **Pane restoration after reload** (`restore.js`): each tab's LAST result is
  restored into its pane lazily (only the active tab + the Video tab on
  load; the others when they become active, and only if the pane is still
  empty — a live session wins). Restores the entry the pane was navigating
  (`paneCurrentEntry`) and keeps the URL row in sync.
- **Lost-job recovery** (`api.js` `registerRecoverHandler` /
  `tryRecoverResult`): if the in-flight fetch is aborted (background tab /
  suspension) the backend keeps running; on refocus the app polls
  `GET /api/last-result` and finishes the job, painting the result into the
  pane as if the fetch had completed.

### 7.1 Galleries (`gallery.js`)

Three session-scoped galleries, **persisted to localStorage** (`storage.js`
saves them under `comfyTools.userConfig.galleries`; on load they are
restored and validated against the server — dead files are dropped,
never shown):

- **`window.galleryGenerated`** — the Generate lightbox history. Every
  generation joins it via `addGeneratedEntry`. Transformations:
  - **Edit ✏️ / Restore 🩹** `appendTransformedEntry` — APPEND a new entry
    (the original image stays): the transformation's own text is what the
    Show prompt panel shows; if the source was a gallery image, its
    prompt is kept as `originalPrompt`. **Clicking the "Edited"/"Restored"
    badge hides it and shows a single box (`#galleryBadgeBox`) with ONLY
    the ORIGINAL generation prompt** (no label, no transformation text;
    nothing appears when the entry has no original prompt). The box always
    carries the TRUE original generation prompt: for a CHAINED edit/restore
    (the source is itself a transformation) the source entry's
    `originalPrompt` is inherited, never the intermediate transformation
    text (the bottom Show-prompt box holds that). While the badge box is
    open the bottom Show-prompt button is hidden too (one box at a time) —
    both always come back on close/navigate (renderGalleryItem re-derives
    them from the entry). Restore may
    have no prompt — the Show prompt button is hidden, but the badge
    still opens the original-prompt box when there is one. Edits of
    non-gallery sources (uploads / external URLs) have no original
    prompt, so the badge click shows nothing.
  - **Upscale 🔍** `addTransformedEntry` — REPLACES the source entry in
    place: the generation prompt stays as the Show prompt content, badge
    "Upscaled" — **informational only, no click action** (`.no-action`,
    default cursor; an upscale has no original prompt to show).
  - **Prompt display**: the prompt is NOT a bottom caption anymore. A
    **Show prompt** button sits bottom-center, visible only when the entry
    has a prompt; **hovering it is enough** — the prompt appears as a
    **bottom panel** (`#galleryPromptModal`). **Clicking the button hides
    it and PINNS the panel open** (`promptPinned` — the pointerleave fired
    when the button disappears does not close it); clicking anywhere else
    (or Escape) closes the panel and restores the button. **ALL gallery
    text boxes share ONE unified family** (`.gallery-prompt-btn`,
    `.gallery-prompt-box`, `.gallery-badge`, `.gallery-counter` and the
    compare-slider labels): system-ui, weight 400 (no bold anywhere),
    13px/1.5, white on the dark translucent surface
    (`rgba(28,28,28,.72)`), 1px light border, 10px radius, one box-shadow,
    and the SAME fixed padding (8px 14px) — the prompt BOXES reduce the
    vertical part to 4px so they hug the text tightly (the height adapts
    to the content; long text caps at `calc(100dvh - 96px)` and scrolls,
    text anchored TOP). Boxes hug their text
    (`width: fit-content`) so the size adapts to the content, with the
    SAME max-width (`min(560px, 86vw)`). Alignment: LEFT everywhere except
    the Show-prompt button, whose label is CENTERED (it is a button).
    **The Show-prompt panel and the badge box use the SAME container**
    (centered via `left:50% + translateX(-50%)`, `padding:0`) and in
    **portrait (<1024px) BOTH expand to the full screen width** (margins
    0 12px, box width 100%) — landscape keeps the fitted box.
    The panel's overlay layer is pointer-transparent, so the image and
    the gallery buttons stay usable. An open box renders ABOVE the
    overlay controls (✕, ⬇, ‹ ›, 🗑️, counter): where the box covers a
    button, the first tap closes the box (tap-anywhere) and the button
    works on the next tap — deliberate progressive dismiss. It hides on
    pointer leave (grace
    delay), Escape, gallery navigation (‹ › / ←/→) and gallery close;
    navigation also closes the badge box. **Any open text box closes on a
    click anywhere** (image, box, backdrop) via `closeTextBoxes()`, which
    restores the badge and the Show-prompt button.
  - Identification by ComfyUI filename (`filenameFromUrl` handles
    `/media/..`, `/view?filename=..`).
- **`window.galleryComparisons`** — the Edit/Upscale ⛶ compare gallery:
  edited/restored/upscaled before/after pairs (`addCompareEntry`, deduped by
  the AFTER image URL). `collectCompareEntries()` merges the registry with
  any `[data-gallery="1"]` sliders still in the DOM (reload fallback).
- The overlay (`#galleryOverlay`) opens fullscreen: lightbox for Generate
  (big image **edge to edge — `100vw/100vh`, no frame/radius** + Show
  prompt button + badge (click → original-prompt box) + ‹ › + N/M counter
  bottom-right + download top-left + close ✕ top-right), compare slider for
  Edit/Upscale (interactive before/after, also maximized to the viewport).
  The N/M counter and the ‹ › buttons are always visible; with a single
  entry ‹ › render disabled (greyed, no action) instead of disappearing.
  Escape/✕/backdrop close; ←/→ navigate.
- **Pane ‹ › navigation (normal view)**: each tool's output pane shows its
  gallery's most recent entry; when the tool's gallery holds more than one
  entry, ‹ › buttons appear vertically centered on the pane's sides
  (`.output-overlay-btn.pane-nav`, hidden with a single entry). They
  navigate the SAME session registries as the fullscreen gallery — without
  leaving the app: Generate cycles `galleryGenerated` (pane shows a plain
  result image), Edit/Upscale cycle their `galleryComparisons` (the
  before/after slider is re-rendered via `restoreCompareSlider`), Video
  cycles `galleryVideos` (player rebuilt). The nav index resets to the most
  recent when a new result lands or the gallery drops to ≤1 entry
  (`syncPaneNav`), and stays in sync on delete/trash/restore/prune.
- **Video gallery (fullscreen ⛶)**: `openVideoGallery` shows
  `window.galleryVideos` in the overlay with the custom player (edge to
  edge) — ‹ › navigates, the 🗑️ deletes the shown entry, the N/M counter
  is bottom-right. The badge AND the Show-prompt button are NOT shown in
  video mode (the player fills the overlay; the prompt would overlap the
  controls).

## 8. Deviations from the mockup (code is source of truth)

These are intentional, user-driven changes over the original `docs/mockup.html`:

1. **Nav**: ☰ hamburger settings at top-left (was "🎨 Comfy Tools ▾" at
   right); per-tab model/gear/reset toolbar at right (was in the params
   pane); Edit/Upscale no longer show a model selector.
2. **Prompt**: in landscape it lives inside the params pane (fills the
   height, with the ✕ clear top-right and the parameter/action chips at
   the bottom); the bottom bar only holds it in portrait.
3. **Result URL row**: below the prompt (not a separate full-width bar in
   landscape).
4. **Advanced modal**: LoRA JSON textarea replaced by the visual row editor;
   model name/diffusion are dropdowns from ComfyUI; video varies by Wan
   version (wan22 dual high/low); per-version config store.
5. **Negative prompt**: moved into the advanced modal (video).
6. **Upscale**: special compact layouts (portrait: seed + 🔍 in the pane,
   no bottom bar; landscape: 🔍 above the URL row in the pane).
7. **Output fills the pane**: `width/height:100%` + `object-fit:contain`,
   no padding, no border-radius/shadow — the generation is edge to edge
   in the pane (no frame, no dashed border).
8. **Source URL field**: collapsible 10%/50%, fades while generating.
9. **Buttons disabled with empty prompt** + click-catcher feedback.
10. **Random seed shown** in the field (client-generated, sent explicitly).
11. **localStorage persistence** of all user config.
12. Default image model is **Krea 2** (was Z-Image Turbo).
13. **Source preview**: the ✓ button next to the source URL field validates
the value and shows the image in the output pane; 🔗/📁 also preview the
source (`.source-preview`, dimmed, no frame). Added over the mockup.
14. **Parameter + action chips (all tools)**: the per-tab parameter
controls moved
out of the params panes into chips overlaid on the prompt textarea (each
opens a small popover with the controls — the same elements, moved into
`#chipPopover`; IDs unchanged, so persistence/reset keep working), and the
ACTION buttons (✨/🖌️/🩹/🎬 + 🪄 refine) are chips too, bottom-right of
the field (`.btn-col` moved inside `.prompt-input-wrap`):
    - **Generate 🖼️**: 📏 dimensions (shows the current aspect ratio, e.g.
      `2:3`) + 👣 steps & seed.
    - **Edit ✏️**: 👣 steps & seed.
    - **Video 🎬**: 🎞️ frames + 👣 steps & seed.
    - **Upscale 🔍**: NO chips — it has no prompt textarea, so its seed
      control stays directly in the params pane (as before).
The 👣 chips show `steps · 🎲` while the seed is random and drop the
separator + dice when the seed is FIXED (steps only). The action chips
(bottom-right) mirror the portrait modal pills: 🪄 refine + the tool's
generation chip(s) (✨/🖌️/🎬, accent background; 🩹 restore in Edit);
the click-catchers, generation lock and stop-by-transformation (⏹) work
on the chips exactly as on the old buttons.
The
prompt fills the whole params pane in landscape; in portrait the chips
appear inside the fullscreen prompt modal (Upscale keeps its pane), and
the bottom bar shows the prompt field WITH the action chips inside it
(generate without the modal — see deviation 14 below). The
portrait prompt modal also
holds **overlay action pills** larger than the chips: ✕ clear (top-right),
🪄 refine + 🩹 restore (Edit only, right of 🪄) + ✨ direct generation
(bottom-right, per-tab glyph; the ✨ uses the accent background like the
buttons outside, 🪄/🩹 stay neutral; the matching button becomes ⏹
during a generation). `refactor/unify-action-buttons`.
15. **Stop button fix**: the ⏹ (stop-transformed trigger) is ENABLED, so
the click-catcher overlay no longer sits on top of it (`.btn-col.generating
.btn-wrap:has(.btn-generate:not(:disabled)) .btn-catcher { display: none }`)
— a click on the ⏹ cancels directly instead of hitting the invisible
catcher. **Tap outside the prompt field** closes the portrait prompt modal
(header / modal padding); taps on the textarea and its overlay buttons
keep working — and so do the prompt-chip popovers (#chipPopover is a
top-level element OUTSIDE .prompt-input-wrap, so the modal's outside-click
dismiss exempts it explicitly: the 📐 select and the +/− steppers inside it
must not close the dialog).
16. **Gallery badge box (click-only)**: the Edited/Restored badge hides
itself on click and shows a single box with ONLY the original prompt
(`#galleryBadgeBox`); the Upscaled badge is informational only (no
action); the Show-prompt button also hides itself on click (pinned
panel); in portrait BOTH prompt boxes expand to full width — see §7.1.
