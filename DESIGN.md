# Design Document — Gradio Comfy Tools

## Overview

Unified Gradio interface that consolidates four ComfyUI-powered tools into a
single multi-tab web application. Each tool occupies its own tab, sharing a
consistent layout: generation output on the left, parameters on the right, and
a full-width prompt area at the bottom.

## Tools

### 1. Generate Image (`smart_generate_image`)

Generates images from text prompts using one of three model families:
Z-Image Turbo, Krea 2, or FLUX.2 Klein.

**Workflow**: `smart_generate_image.json`  
**Key nodes**: CLIPLoader (qwen3_4b), UNETLoader, FluxResolutionNode,
SamplerCustomAdvanced, VAEDecode, Power Lora Loader

**Parameters (right panel)**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Model family | Dropdown | Z-Image Turbo | zimage, krea2, flux2_klein. Changing the model **automatically sets the steps slider** to the default for that family and **updates the width/height** because each model has a different VAE scale factor (divisible_by). |
| Aspect ratio | Dropdown | 2:3 (Portrait) | 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, custom |
| Custom ratio (W:H) | Text × 2 | — | Only shown when aspect_ratio = custom. Inline fields for width and height ratio. |
| Megapixels | Slider | 1.0 | Resolution target (0.1 – 2.0, step 0.1). Together with aspect ratio and VAE scale factor, determines the final width and height. |
| Width / Height | Read-only | Auto | Calculated from megapixels × aspect ratio, rounded to nearest multiple of the model's VAE scale factor. Updates live when any of the three inputs (model, aspect ratio, megapixels) change. |
| Steps | Number (stepper) | 10 | Inference steps (1 – 15). Auto-updates when model family changes: Z-Image Turbo → 10, Krea 2 → 8, FLUX.2 Klein → 8. |
| Seed | Number + checkbox | Random ✓ | Numeric seed with "Random" checkbox. When checked, seed field is disabled and a random seed is generated on submit. Typing a value unchecks it. |
| LoRAs | Dynamic list | none | Up to 4 LoRAs (name + strength) |

**Prompt input (bottom, full width)**: Single textarea for the generation
prompt.

**Generation output (left)**: The generated image displayed in a container
that fits the available area, with a lightbox/modal on click.

**Resolution auto-calculation**: Width and height are derived from three
inputs and update live whenever any of them changes:

```
total_pixels = megapixels × 1_000_000
raw_w = √(total_pixels × ratio_w / ratio_h)
raw_h = raw_w × ratio_h / ratio_w
width  = round(raw_w / vae_scale) × vae_scale
height = round(raw_h / vae_scale) × vae_scale
```

Each model family uses a different VAE with its own spatial compression
factor, inherited from the workflow's `FluxResolutionNode.divisible_by`:

| Model family | VAE scale factor |
|--------------|:---:|
| Z-Image Turbo | 16 |
| Krea 2 | 8 |
| FLUX.2 Klein | 64 |

**Advanced parameters** (⚙️ modal):
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Model name | Text | — | Override .safetensors file |
| LoRA config | JSON textarea | — | JSON array of LoRAs: `[{"name":"...","strength":1.0}]` |
| Override system LoRAs | Toggle | Off | Replace admin LoRAs entirely |
| Image base URL | Text | — | Override ComfyUI image link base URL |

---

### 2. Edit Image (`edit_image`)

Edits an existing image using Flux 2 inpainting. Supports edit and restore
modes.

**Workflow**: `edit_image.json`  
**Key nodes**: CLIPLoader (qwen_3_8b), UNETLoader (flux-2-klein), KSampler,
VAEEncode/Decode, LoadImageByUrlOrPath, ImageScaleToTotalPixels,
ImageUpscaleWithModel, ReferenceLatent

**Parameters (right panel)**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Source image | Image upload | — | The image to edit (or URL) |
| Mode | Radio | Edit | Edit / Restore |
| Steps | Slider | 6 | Inference steps (1 – 15) |
| Seed | Number | Random | Auto-generated random seed |
| LoRAs | Dynamic list | none | Up to 4 LoRAs (name + strength) |

**Prompt input (bottom, full width)**: Textarea for the edit description
(e.g., "change the background to a beach at sunset"). In restore mode, this
is optional.

**Generation output (left)**: Before/after comparison slider showing original
vs edited image.

**Advanced parameters** (⚙️ modal):
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| LoRA config | JSON textarea | — | JSON array of LoRAs |
| Override system LoRAs | Toggle | Off | Replace admin LoRAs entirely |
| Image base URL | Text | — | Override ComfyUI image link base URL |

---

### 3. Upscale Image (`upscale_image`)

Upscales images using SeedVR2 (diffusion-based super-resolution).

**Workflow**: `seedvr2_upscale.json`  
**Key nodes**: SeedVR2LoadDiTModel, SeedVR2LoadVAEModel,
SeedVR2VideoUpscaler, LoadImageByUrlOrPath, ImageBlend

**Parameters (right panel)**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Source image | Image upload | — | The image to upscale |
| Resolution | Slider | 2048 | Target resolution (1024 – 4096) |
| Blend factor | Slider | 0.15 | Original/upscaled blend (0.0 – 1.0) |
| Color correction | Dropdown | lab | lab / rgb / none |
| Seed | Number | 0 | Random seed |

**Prompt input (bottom)**: None. This tool does not use a prompt — the bottom
area can be collapsed or hidden for this tab.

**Generation output (left)**: Before/after comparison slider showing original
vs upscaled image.

**Advanced parameters** (⚙️ modal):
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Image base URL | Text | — | Override ComfyUI image link base URL |

---

### 4. Generate Video (`generate_video`)

Generates videos from an image and a motion prompt using Wan 2.1 or Wan 2.2
image-to-video.

**Workflows**: `generate_video.json` (Wan 2.1), `generate_video_wan22.json`
(Wan 2.2)

**Key nodes (Wan 2.1)**: CLIPLoaderGGUF (umt5-xxl), UNETLoader,
WanImageToVideo, KSamplerAdvanced, WanVideoNAG, VHS_VideoCombine,
RTXVideoSuperResolution, FrameInterpolate

**Key nodes (Wan 2.2)**: Same as 2.1 plus dual-path high/low with separate
UNETs, samplers, and model sampling shifts.

**Parameters (right panel)**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Source image | Image upload | — | The starting image |
| Model version | Dropdown | Wan 2.1 | wan21 / wan22 |
| Frames (length) | Slider | 81 | Must be 4n+1 (5 – 161) |
| Steps | Slider | 4 | 4 – 10 (odd→even for Wan 2.2) |
| Seed | Number | -1 | -1 = random, ≥0 = fixed |
| Negative prompt | Textarea | — | Optional, overrides default |
| LoRAs | Dynamic list | none | Per-path LoRAs for Wan 2.2 |

**Prompt input (bottom, full width)**: Textarea for the motion description
(e.g., "a cat walking slowly through a field of flowers, gentle breeze").

**Generation output (left)**: Video player (`<video>` with controls, autoplay,
loop, muted).

**Advanced parameters** (⚙️ modal):
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| Diffusion model | JSON textarea | — | Override model file(s). Object for Wan 2.1, array for Wan 2.2 |
| LoRA config | JSON textarea | — | JSON array, supports per-path LoRAs via `"path"` field |
| Image base URL | Text | — | Override ComfyUI video link base URL |

### Advanced parameters modal (all tabs)

A single ⚙️ gear button sits on the **left** side of the tab bar (aligned
with the output area's left edge). Clicking it opens a modal with the advanced
parameters for whichever tab is currently active. The modal shows **user-level valves only** — the ComfyUI admin
valves are configured server-side and not exposed here. The modal contains:

- Tool-specific advanced fields as listed above.
- A "Save" button that applies the values and closes the modal.
- A "Cancel" or X button that discards changes and closes.
- Values persist across tab switches during the session.

---

## Layout

### Landscape / desktop (≥1024px)

```
┌─────────────────────────────────────────────────────────┐
│ ⚙️ [Generate Image] [Edit] [Upscale] [Video]  🎨 Comfy Tools ▾ │  ← Single bar
├───────────────────────────┬─────────────────────────────┤
│                           │  Model family: [dropdown]   │
│     Generation Output     │  Aspect ratio: [dropdown]   │
│     (image / slider /     │  W: [832] H: [1248] MP:[-] │
│      video)               │  Steps: [-] Seed:[_] ☑Rand │
│                           │  LoRAs:       [+ Add]      │
│                           │                             │
│                           │  [Generate] [Reset]         │
├───────────────────────────┴─────────────────────────────┤
│  Prompt: [                                        🖼️📎] │  ← Full-width prompt
└─────────────────────────────────────────────────────────┘
```

### Portrait / tablet / mobile (<1024px)

```
┌──────────────────────────────────────┐
│ ⚙️ [Gen] [Edit] [Upscl]…  🎨 C… ▾  │  ← Single bar
├──────────────────────────────────────┤
│                                      │
│        Generation Output             │  ← Output on top
│        (image / slider / video)      │
│                                      │
├──────────────────────────────────────┤
│  Model family: [dropdown]            │  ← Parameters below
│  Aspect ratio: [dropdown]            │
│  W: [832]  H: [1248]  MP: [-] [+]   │
│  Steps: [-] [+]  Seed: [_] ☑Random  │
│  [Generate] [Reset]                  │
├──────────────────────────────────────┤
│  Prompt: [                     🖼️📎] │  ← Full-width prompt
└──────────────────────────────────────┘
```

### Layout details

- **Single combined bar (tabs bar)**: sits at the very top. Contains:
  - **⚙️ gear button** (left): aligned with the output area's left edge.
    Opens the advanced parameters modal for the currently active tab.
  - **Tab buttons** (center-left): switch the content area
    (output + parameters + prompt). The active tab is highlighted with
    a colored underline.
  - **🎨 Comfy Tools ▾ dropdown** (right): clicking it opens a settings
    menu with appearance (light/dark theme toggle) and ComfyUI
    connection settings (server URL, image base URL).
- **Landscape (≥1024px)**:
  - **Left panel (output)**: Takes ~60% of the width. Contains the generation
    result. For image tools: a centered image with lightbox on click. For edit
    and upscale: a comparison slider (original vs result). For video: a video
    player.
  - **Right panel (parameters)**: Takes ~40% of the width. Scrollable if
    parameters exceed the available height. Contains tool-specific controls.
    A "Generate" button at the bottom of the panel triggers the ComfyUI job.
- **Portrait (<1024px)**:
  - **Top area (output)**: Generation result displayed first, just below the
    tabs. Takes available width and scales proportionally. This is the
    natural focal point — the user sees the result before scrolling to tweak
    parameters.
  - **Middle area (parameters)**: Controls stacked below the output. The
    page scrolls naturally; no internal scroll regions compete for vertical
    space on tall phone screens.
  - **Bottom area (prompt)**: Always at the very bottom, full width.
- **Prompt bar**: Full width in both orientations. Contains a multi-line
  textarea for the prompt (image generation, edit description, motion prompt)
  plus optional attachment buttons. For upscale (no prompt), this area can
  be hidden or collapsed. On portrait, the prompt is the last element so the
  on-screen keyboard doesn't push it out of view while the output remains
  visible above.

---

## Color scheme and theming

- **Dark theme** (default): matches the ComfyUI dark aesthetic.
  - Background: `#1a1a2e` (deep navy)
  - Surface: `#16213e` (card backgrounds)
  - Accent: `#e94560` (buttons, active tab, slider tracks)
  - Text: `#eaeaea` (primary), `#a0a0b0` (secondary)
  - Borders: `#2a2a4a`
- **Light theme**: via `prefers-color-scheme: light` or a manual toggle.
- Uses CSS custom properties for easy theme switching.

---

## ComfyUI Integration

The Gradio app communicates with a ComfyUI backend via its REST API:

1. **Workflow submission**: POST the workflow JSON with injected parameters
   to `/prompt`.
2. **Progress polling**: GET `/history/{prompt_id}` to track execution.
3. **Result retrieval**: Images/videos served from ComfyUI's output directory
   via the configured base URL.

### Settings dropdown (🎨 Comfy Tools ▾)

Clicking the title on the right of the tab bar opens a dropdown menu with:
- **Theme toggle**: switch between dark (default) and light mode
- **ComfyUI server URL**: configure the backend endpoint
- **Image base URL**: override the base URL for generated images/videos

---

## State and session

- Each tab maintains its own parameter state independently. Switching tabs
  does not reset the parameters.
- Generation results persist across tab switches during the session.
- A "Reset" button in each tab clears the output and resets parameters to
  defaults.
- The last generated output URL (context) is available for chaining: the
  edit, upscale, and video tools can accept the output of the image generator
  as their source image.

---

## Technologies

- **Gradio**: Python web framework for the UI (Blocks API with custom layout).
- **ComfyUI REST API**: Backend for all generation tasks.
- **Python**: Glue logic, workflow JSON injection, API communication.
- **HTML/CSS/JS**: Custom Gradio components for the comparison slider,
  lightbox, and video player.

## Files

| File | Purpose |
|------|---------|
| `DESIGN.md` | This document |
| `mockup.html` | Interactive HTML mockup for visual validation |
| `app.py` | Main Gradio application (to be implemented) |
| `comfy_client.py` | ComfyUI REST API client (to be implemented) |
| `tools/` | Per-tool modules (to be implemented) |
| `workflows/` | ComfyUI workflow JSON files (to be imported) |
