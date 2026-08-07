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

- **Generate an image**: type a description in the bottom text field and press ✨.
- **Edit / restore**: upload an image (📁), paste a URL, or use 🔗 to take the last generated image. Describe the change and press 🖌️ (edit) or 🩹 (restore).
- **Upscale**: set the source image and press 🔍.
- **Generate a video**: set the source image, describe the motion, and press 🎬.

### Source images (Edit, Upscale, Video)

- **📁** uploads a file from your computer.
- **🔗** uses the last generated image.
- **Paste a URL** and confirm with **✓** to validate and preview the image before processing.

### During a generation

- The bottom bar shows **live progress** (current node and completed steps).
- The **⏹** button stops the running generation.
- When finished, the result URL appears with the **📋** button to copy it.

### Settings

- **☰** (top-left): light/dark theme and ComfyUI connection settings (server URL and results URL).
- **⚙️** (per tab): advanced options — model, LoRAs, video negative prompt.

## Troubleshooting

- **"Could not reach the URL"**: check that the ComfyUI server is running and that the URL is correct (☰ menu).
- **The source image is not valid**: the URL does not point to an accessible image; use 📁 or a direct image URL.
- Results appear in the browser and can take from a few seconds (images) to several minutes (videos).

## Technical documentation

- `BACKEND.md` — architecture and ComfyUI integration.
- `FRONTEND.md` — interface specification.
- `DESIGN.md` — design overview.
- `PLAN.md` — implementation plan status.

## License

Internal project, no specific license.
