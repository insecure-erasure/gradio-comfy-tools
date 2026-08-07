# Backend Design — Comfy Tools

> **Implementation reference: the tools in `../open-webui-comfy-tools`** (`smart_generate_image/`, `edit_image/`, `upscale_image/`, `generate_video/`). Our backend reimplements their behavior (workflow injection, parameter semantics, ComfyUI REST) without Open WebUI plumbing.
>
> The contract with the UI is `FRONTEND.md`; here every UI control maps to a backend parameter and a workflow node.

## 1. Architecture

| Module | Responsibility |
|---|---|
| `server.py` | FastAPI app: renders the modular UI (`templates/` + `static/`) + the REST API that calls `tools/`; proxies results via `/media` |
| `comfy_client.py` | ComfyUI REST client: queue, polling, upload, output URLs |
| `tools/` | One module per tool: workflow JSON loading + parameter injection by node title |
| `workflows/` | The workflow JSONs imported from `../open-webui-comfy-tools` |

## 2. ComfyUI integration (comfy_client.py)

1. **Submit**: `POST /prompt` with the (API-format) workflow and injected parameters.
2. **Poll**: `GET /history/{prompt_id}` until the prompt completes; handle timeout and `POST /interrupt` on cancel.
3. **Upload**: `POST /upload/image` (multipart) for user-uploaded source images in Edit/Upscale/Video; the resulting filename feeds the `Load Image (URL/Path)` node.
4. **Results**: the public URL is `{COMFYUI_MEDIA_BASE_URL}/view?filename=...&type=output`. Images from `SaveImage`/`Random Preview Image`; videos from `VHS_VideoCombine` (`Output MP4`).
5. **Config**: server URL (`COMFYUI_BASE_URL`, default `http://localhost:8188`), media base URL (`COMFYUI_MEDIA_BASE_URL`, default: derived from the server URL), optional API key.

### Model listings (for the UI dropdowns)
- `list_loras()` → `GET /models/loras`; `list_diffusion_models()` → `GET /models/diffusion_models`. Both handle a list of strings or a list of `{name}` objects.
- Exposed to the UI via `GET /api/loras` and `GET /api/diffusion-models` (same-origin proxies).

### Image validation (source preview ✓)
- `POST /api/check-image` (`server.py`) validates that a source value is a
  reachable image **server-side** — the browser cannot read cross-origin
  headers (verified: ComfyUI serves `Access-Control-Allow-Origin` only for
  its allowed origin).
- Uses the **same filename-vs-URL auto-detection as the tools**
  (`tools._common.normalize_source`): external URL → checked directly;
  otherwise → treated as a ComfyUI temp filename and checked against
  `{media_base}/view?filename=...&type=temp` (the exact `source="temp"`
  decision `configure_image_node` makes).
- Accepts when the Content-Type starts with `image/` **or** the first bytes
  match an image magic signature (PNG/JPEG/GIF/WebP/BMP/TIFF) — some servers
  serve images as `application/octet-stream`. Returns `{ok, content_type}`
  or `{ok: false, error}` (always HTTP 200 so the UI distinguishes
  "not an image" from a transport failure).

### Live progress (B5-lite)
- `comfy_client.queue_prompt` **materializes the client_id** (random when not
  given) and fires module-level **prompt hooks** (`register_prompt_hook`,
  called with `(client_id, prompt_id, workflow)`).
- `server.py` registers a hook that spawns a **daemon thread per job**: it
  opens a WebSocket to ComfyUI with the **same clientId** used for
  `POST /prompt`, follows that prompt's events (`executing`/`progress`/
  `execution_success`) and updates an in-memory `_jobs` store (stage, node,
  node_title, value/max, done, error). The WS is best-effort: if it fails,
  the existing `wait_for_output` polling still completes the job.
- `GET /api/progress` exposes the most recent active job — the frontend
  polls it and paints the stage in the result URL row.
- **Cancel** (`POST /api/cancel`): `ComfyClient.interrupt()` (`POST
  /interrupt`, empty body / Content-Length 0) stops the running prompt;
  `ComfyClient.cancel_prompt(pid)` (`POST /queue` `delete`) removes the
  pending one; the job is marked done so progress goes idle.
- Verified live: `queued` → `SamplerCustomAdvanced 1/8..8/8` → `VAE Decode`
  → `Random Preview Image` → done; `/interrupt` and `/queue delete` both
  return 200 on the live server.

## 3. Workflow injection pattern (tools/)

Identical to the Open WebUI tools: load the JSON, resolve each node by its **unique `_meta.title`** and override `inputs`. The titles used are the same as in `../open-webui-comfy-tools` (listed in the contract tables of §5).

Workflow JSONs are copied from `../open-webui-comfy-tools/<tool>/` into `workflows/` (unmodified unless documented).

## 4. Configuration model

No override layers: the app is single-user, so there is no admin/user
hierarchy and no "override system LoRAs" concept. Every value is direct
configuration:

- **Global settings** (🎨 dropdown + defaults): server URL (`COMFYUI_BASE_URL`), media base URL (`COMFYUI_MEDIA_BASE_URL`), theme, default LoRAs, default models.
- **Per-tab UI controls** (params pane + advanced modal): tool parameters.
- **Workflow default**: hardcoded values in the JSON.

Precedence: `UI control / global setting  >  workflow default`

## 5. Per-tab contracts (UI control → parameter → workflow node)

### 5.1 Generate 🖼️ — `smart_generate_image.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| Model family dropdown | `model_family` (zit / krea2 / flux.2) | `Load Diffusion Model`, `Load CLIP`, `Load VAE` (models from the family config) |
| W/H readonly (auto) | `megapixel` + `aspect_ratio` (w:h) | `Flux Resolution Calc` |
| AR dropdown | `aspect_ratio` (w:h) | `Flux Resolution Calc` |
| 📐 MP stepper | `megapixel` (0.1–2.0) | `Flux Resolution Calc` |
| 👣 Steps (auto per family) | `steps` | `Steps` (via `BasicScheduler`) |
| 🌱 Seed + 🎲 | `seed` (🎲 → -1/random) | `RandomNoise` |
| LoRAs (advanced modal: `LoRA config (JSON)`) | `lora_config` | `Power Lora Loader (rgthree)` |
| Prompt (bottom bar) | `prompt` | `Prompt` → `CLIP Text Encode (Prompt)` |
| Modal: Model name | `model_name` (.safetensors) | `Load Diffusion Model` |

Other relevant nodes: `SamplerCustomAdvanced`, `KSamplerSelect`, `CFGGuider`, `Switch (SIGMAS)`, `VAE Decode`; output: `Random Preview Image`.

**Family config** (same as `MODEL_CONFIGS` in `smart_generate_image/tool.py`):

| Family | Model | Text encoder | VAE | vae_scale | cfg | steps | sampler | scheduler |
|---|---|---|---|---|---|---|---|---|
| Z-Image Turbo | zImageTurbo-mxfp8.safetensors | qwen3_4b_instruct_2507_mxfp8 | Z-Image_half_natural_vae | 16 | 1.0 | 10 | euler | simple |
| Krea 2 | krea2_turbo_mixed_nvfp4 | qwen3_vl_4b_instruct_mxfp8 | qwen_image_vae | 8 | 1.0 | 8 | euler | simple |
| FLUX.2 Klein | flux-2-klein-9b-nvfp4 | qwen_3_8b_nvfp4 | flux2-vae-small-bf16 | 64 | 1.0 | 8 | euler | (flux.2) |

### 5.2 Edit ✏️ — `edit_image.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 📁 Upload / 🔗 previous / URL field | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🖌️ Edit / 🩹 Restore (buttons) | `mode` ("edit" / "restore") | restore: appends `Flux2-Klein-Image-RestoreV1.safetensors` to `Power Lora Loader (rgthree)` + restoration prompt prefix |
| 👣 Steps | `steps` (1–15, default 6) | `KSampler` |
| 🌱 Seed + 🎲 | `seed` (-1 → random, ≥0 → fixed) | `KSampler` |
| Modal: LoRA config | `lora_config` | `Power Lora Loader (rgthree)` |
| Prompt (bottom bar; optional in restore) | `prompt` | `Prompt` |

Other nodes: `Load Diffusion Model` (flux-2-klein), `Load VAE`, `VAE Encode/Decode`, `ReferenceLatent`, `Empty Flux 2 Latent`, `ImageScaleToTotalPixels`, `Upscale Image (using Model)` / `Load Upscale Model`, `ConditioningZeroOut`, `Concatenate`; output: `Random Preview Image`.

**✅ Seed supported**: the reference `edit_image/tool.py` exposes `seed` since v1.6 (UserValve, -1 = random, ≥0 = fixed, injected into `KSampler`).

### 5.3 Upscale 🔍 — `seedvr2_upscale.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 📁 Upload / 🔗 previous / URL field | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🌱 Seed + 🎲 | `seed` (-1 → random, ≥0 → fixed) | `SeedVR2 Video Upscaler (v2.5.24)` |
| — (no control) | `resolution` 2048 | `SeedVR2 Video Upscaler` |
| — (no control) | `color_correction` "lab" | `SeedVR2 Video Upscaler` |
| — (no control) | `blend_factor` 0.15 | `Image Blend` |

Other nodes: `SeedVR2 (Down)Load DiT Model` → **`SeedVR2LoadDiTModel`**, `SeedVR2 (Down)Load VAE Model` → **`SeedVR2LoadVAEModel`**, `SeedVR2 Video Upscaler (v2.5.24)` → **`SeedVR2VideoUpscaler`** (exact names confirmed on the dev server; `scripts/check_env.py` validates them); output: `Random Preview Image`.

**⚠️ Note vs the old design** (resolved decisions):
- `upscale_image/tool.py` exposes `seed` since v1.4 (UserValve, -1 = random, ≥0 = fixed, injected into `SeedVR2 Video Upscaler`).
- Resolution / blend / color correction stay **fixed in the workflow** (2048, 0.15, "lab") — not exposed in the UI. Decision: keep them as workflow defaults.
- No advanced modal: there are no tool-level advanced fields (the media base URL is a global setting, see §7).

### 5.4 Video 🎬 — `generate_video.json` / `generate_video_wan22.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| Model dropdown (Wan 2.1 / 2.2) | `model_version` (wan21 / wan22) | workflow file selection + `Load Diffusion Model`(s) |
| 📁 Upload / 🔗 previous / URL field | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🎞️ Frames (81–161, 4n+1) | `length` (4n+1 snap) | `WanImageToVideo` |
| 👣 Steps (4–10) | `steps` (wan22: odd→even) | `KSampler` (title "KSampler", class KSamplerAdvanced) |
| 🌱 Seed + 🎲 | `seed` (🎲 → -1/random) | `EasySeed` |
| Negative Prompt | `negative_prompt` (overrides default) | `Negative Prompt` |
| Modal: Diffusion model (JSON) | `diffusion_model` (object wan21 / array wan22 with `path`) | `Load Diffusion Model`(s) per `path` (high/low) |
| Modal: LoRA config (JSON) | `lora_config` (supports `path` high/low) | `Power Lora Loader (rgthree)` (filtered per path) |
| Prompt (bottom bar) | `prompt` (motion) | `Positive Prompt` |

Other nodes (wan21 and wan22): `CLIPLoader (GGUF)`, `WanImageToVideo`, `KSamplerAdvanced`, `WanVideoNAG` ("NAG HIGH"), `ModelSamplingSD3`, `SageAttention`, `VAE Decode`, `Frame Interpolate`, `RTX Video Super Resolution`, `Image Blend`, `Unsharpen mask`, `CLIP Vision Encode`; output: `Output MP4` (VHS_VideoCombine). Wan 2.2 adds the dual high/low path (two `Load Diffusion Model`, two `KSampler`, model sampling shifts).

**Model config** (same as `generate_video/tool.py` + README):
- **Wan 2.1**: single path — `Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v-nvfp4.safetensors`, sampler euler, scheduler simple, steps 4, cfg 1.0, shift 5.
- **Wan 2.2**: dual high/low path — `Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-{high,low}-nvfp4.safetensors`; high: heun, start 0 / end 2, add noise; low: euler, start 2 / end 10000, no noise.

**Frames guardrail**: `_MIN_FRAMES=81`, `_MAX_FRAMES=161`, only 4n+1 valid; snap to the **nearest** 4n+1: `snapped = ((n-1)//4)*4+1`, then `snapped += 4` when `n - snapped > 2` (clamped) — exact mirror of `_snap_to_valid_frames` in `generate_video/tool.py`; the mockup implements the same logic (`snapVideoFrames`). **Steps guardrail**: 4–10; wan22 rounds odd→even.

## 6. Chaining (context between tools)

- `lastGeneratedUrl` (per session): the output URL of the last generation, built as `{COMFYUI_MEDIA_BASE_URL}/view?filename=...&type=output`. **Persists across tab switches** so it can be used after generating in another tab.
- Consumers: 📋 (copy) and 🔗 (fills the source URL field of Edit/Upscale/Video with `lastGeneratedUrl`).
- The source URL field is the tool's `image` input: paste an external URL directly, or use 🔗/📁. When consumed as a source, pass the **filename** (not the full URL) to the `Load Image (URL/Path)` node; for external URLs pass the URL directly (scheme+netloc auto-detection, like the tools).
- If the field is empty on generate, the app should prompt for a source (upload via 📁, use 🔗, or paste a URL).

## 7. Global config (settings)

Global, not per-tool: there is exactly one server URL, one media base URL (`COMFYUI_MEDIA_BASE_URL`) and
one theme for the whole app (no override layers). Configured from the 🎨
dropdown and the settings defaults; the advanced modal only holds tool-level
fields (model, LoRA/diffusion config):

| Setting | Default | UI |
|---|---|---|
| server_url | `http://localhost:8188` | 🎨 dropdown |
| COMFYUI_MEDIA_BASE_URL | derived from the server | 🎨 dropdown |
| theme | dark | 🎨 dropdown |
| model_family | zit | settings |
| lora_config (default) | `[]` | settings |
| diffusion_model (video) | `""` (built-in defaults) | modal (Video) |

## 8. State and session

- Per-tab parameter state, independent; persists across tab switches (kept in the frontend's DOM — tabs are never rebuilt).
- The advanced modal persists its values per tab for the session.
- Reset (↺) restores defaults and clears the tab's output.
- Each tab's result persists for the session (not lost on tab switch).

## 9. Implementation notes

1. **LoRAs are managed exclusively via the advanced modal** (`LoRA config (JSON)` in Generate/Edit/Video); there is no dynamic list in the params pane. `override_system_loras` does not exist (no override layers).
2. **Nodes with title != class** — `KSampler` (class KSamplerAdvanced) and `Output MP4` (VHS_VideoCombine) in video; always resolve by `_meta.title`.
