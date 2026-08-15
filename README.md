# Comfy Tools

Web application with four image and video tools powered by ComfyUI:

| Tab | Tool | What it does |
|---|---|---|
| 🖼️ Generate | Image generation | Creates an image from a text description (model, resolution, steps, seed). |
| ✏️ Edit | Image editing | Modifies an existing image (background, style…). The 🩹 Restore mode recovers damaged or low-quality images. |
| 🔍 Upscale | Quality enhancement | Doubles the resolution of an image (SeedVR2). |
| 🎬 Video | Video generation | Turns an image into an animated video (Wan 2.1 / Wan 2.2). |

## Requirements

- A **ComfyUI** server reachable over the network (the models and nodes for all four workflows must be installed).
- Python 3.10+ to run the application.

## Getting started

1. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

2. Start the application server:

   ```bash
   uvicorn server:app --host 0.0.0.0 --port 8000
   ```

3. Open the browser at `http://<machine-ip>:8000`.

4. The first time, configure the ComfyUI connection from the ☰ menu (top-left) → **Server URL**. The default URL is `http://192.168.1.8`; it can be changed at any time from the same menu. Settings are saved automatically.

## Basic usage

- **Generate an image**: type a description in the prompt field (bottom
  bar in portrait, params pane in landscape) and press ✨.
- **Edit / restore**: upload an image (📁), paste a URL, or use 🔗 to take the last generated image. Describe the change and press 🖌️ (edit) or 🩹 (restore).
- **Upscale**: set the source image and press 🔍.
- **Generate a video**: set the source image, describe the motion, and press 🎬.

### Source images (Edit, Upscale, Video)

- **📁** uploads a file from your computer.
- **🔗** uses the last generated image.
- **Paste a URL** and confirm with **✓** to validate and preview the image before processing.

### During a generation

- The **progress row** shows **live progress** (current node and completed
  steps) plus the **⏱ elapsed time** (1-second precision) while it runs;
  when finished it keeps the **total generation time** (1-decimal
  precision, e.g. `⏱ 12.4s`).
- The **⏹** button (the action button, transformed) stops the running
  generation.
- While a generation runs the prompt field is **locked** and the action and
  🪄 refine buttons are **disabled** (you cannot start another job, refine,
  or type mid-generation).
- When finished, the result URL appears in the hint row next to the ⏱
  duration — **click the URL to copy it** (a confirmation box shows the
  copied URL). The **fullscreen gallery's 📋** button also copies it.

### Settings

- **☰** (top-left): light/dark theme, ComfyUI connection settings (server
  URL and results URL) and the prompt-refiner settings (Refiner URL,
  **model selector** and system prompt for the 🪄 button).
- **⚙️** (per tab): advanced options — model, LoRAs, video negative prompt.

### Prompt refiner model (llama.cpp router)

The 🪄 refiner talks to a llama.cpp server in **router mode** (several
models behind one endpoint). The model used for refinement is chosen in the
☰ menu → **Prompt Refiner → 🤖 Model**, listing what the router serves via
`GET /v1/models` (auto-refreshed when the refiner URL changes). The choice
is persisted in the config file (`prompt_refiner_model`).

- **Auto (router default)**: the router's first model that is not flagged
  as too heavy for refinement (configurable via `REFINER_EXCLUDE`, by
  default the 9B models are skipped so a light 4B/E4B model is used).
- Explicit models are always selectable; the refiner sends the chosen
  `model` id in every request (llama.cpp rejects requests without a model
  name).

## Troubleshooting

- **"Could not reach the URL"**: check that the ComfyUI server is running and that the URL is correct (☰ menu).
- **The source image is not valid**: the URL does not point to an accessible image; use 📁 or a direct image URL.
- Results appear in the browser and can take from a few seconds (images) to several minutes (videos).

## Technical documentation

- `docs/BACKEND.md` — architecture and ComfyUI integration.
- `docs/FRONTEND.md` — interface specification.
- `docs/DESIGN.md` — design overview.
- `docs/PLAN.md` — implementation plan status.
- `docs/mockup.html` — design template/spec (never edited for functionality).

## License

Internal project, no specific license.
