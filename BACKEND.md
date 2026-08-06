# Backend Design — Gradio Comfy Tools

> **Implementation reference: the tools in `../open-webui-comfy-tools`** (`smart_generate_image/`, `edit_image/`, `upscale_image/`, `generate_video/`). The Gradio backend reimplements their behavior (workflow injection, parameter semantics, ComfyUI REST) without Open WebUI plumbing.
>
> The contract with the UI is `FRONTEND.md`; here every UI control maps to a backend parameter and a workflow node.

## 1. Architecture

| Module | Responsibility |
|---|---|
| `app.py` | Gradio Blocks app: layout and state per FRONTEND.md, event wiring, global config |
| `comfy_client.py` | ComfyUI REST client: queue, polling, upload, output URLs |
| `tools/` | One module per tool: workflow JSON loading + parameter injection by node title |
| `workflows/` | The workflow JSONs imported from `../open-webui-comfy-tools` |

## 2. ComfyUI integration (comfy_client.py)

1. **Submit**: `POST /prompt` with the (API-format) workflow and injected parameters.
2. **Poll**: `GET /history/{prompt_id}` until the prompt completes; handle timeout and `POST /interrupt` on cancel.
3. **Upload**: `POST /upload/image` (multipart) for user-uploaded source images in Edit/Upscale/Video; the resulting filename feeds the `Load Image (URL/Path)` node.
4. **Results**: the public URL is `{image_base_url}/view?filename=...&type=output`. Images from `SaveImage`/`Random Preview Image`; videos from `VHS_VideoCombine` (`Output MP4`).
5. **Config**: server URL (default `http://localhost:8188`), image base URL (default: derived from the server URL), optional API key.

## 3. Workflow injection pattern (tools/)

Identical to the Open WebUI tools: load the JSON, resolve each node by its **unique `_meta.title`** and override `inputs`. The titles used are the same as in `../open-webui-comfy-tools` (listed in the contract tables of §5).

Workflow JSONs are copied from `../open-webui-comfy-tools/<tool>/` into `workflows/` (unmodified unless documented).

## 4. Parameter precedence

```
user (tab UI + advanced modal)  >  admin (global settings)  >  workflow default
```

Open WebUI equivalence: **UserValves → UI controls**; **AdminValves → global settings** (server URL, image base URL, admin LoRAs, default models); **workflow default → hardcoded JSON values**.

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
| LoRAs (modal + list) | `lora_config` + `override_system_loras` | `Power Lora Loader (rgthree)` |
| Prompt (bottom bar) | `prompt` | `Prompt` → `CLIP Text Encode (Prompt)` |
| Modal: Model name | `model_name` (override of the .safetensors) | `Load Diffusion Model` |
| Modal: Image base URL | `comfyui_image_base_url` | — (output URLs only) |

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
| 📁 Upload / 🔗 previous | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🖌️ Edit / 🩹 Restore (buttons) | `mode` ("edit" / "restore") | restore: appends `Flux2-Klein-Image-RestoreV1.safetensors` to `Power Lora Loader (rgthree)` + restoration prompt prefix |
| 👣 Steps | `steps` (1–15, default 6) | `KSampler` |
| 🌱 Seed + 🎲 | `seed` (🎲 → random) | `KSampler` |
| Modal: LoRA config / Override | `lora_config` + `override_system_loras` | `Power Lora Loader (rgthree)` |
| Modal: Image base URL | `comfyui_image_base_url` | — |
| Prompt (bottom bar; optional in restore) | `prompt` | `Prompt` |

Other nodes: `Load Diffusion Model` (flux-2-klein), `Load VAE`, `VAE Encode/Decode`, `ReferenceLatent`, `Empty Flux 2 Latent`, `ImageScaleToTotalPixels`, `Upscale Image (using Model)` / `Load Upscale Model`, `ConditioningZeroOut`, `Concatenate`; output: `Random Preview Image`.

**⚠️ Gap vs the reference**: `edit_image/tool.py` does **not expose a user seed** — it generates `random.randint(0, _COMFY_SEED_MAX)` server-side (line ~632). The mockup does have seed + 🎲. **Decision**: the Gradio backend should expose seed (inject into `KSampler`); if strict parity is preferred, remove the control from the UI.

### 5.3 Upscale 🔍 — `seedvr2_upscale.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 📁 Upload / 🔗 previous | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🌱 Seed + 🎲 | `seed` | `SeedVR2 Video Upscaler (v2.5.24)` |
| — (no control) | `resolution` 2048 | `SeedVR2 Video Upscaler` |
| — (no control) | `color_correction` "lab" | `SeedVR2 Video Upscaler` |
| — (no control) | `blend_factor` 0.15 | `Image Blend` |

Other nodes: `SeedVR2 (Down)Load DiT Model`, `SeedVR2 (Down)Load VAE Model`; output: `Random Preview Image`.

**⚠️ Gaps vs the reference and the old design**:
- `upscale_image/tool.py` only exposes `comfyui_image_base_url`; the workflow uses a fixed `seed: 0`. The mockup shows seed + 🎲 → the Gradio backend must inject seed into `SeedVR2 Video Upscaler` (or remove the control from the UI).
- Resolution / blend / color correction **exist in the workflow** but were removed from the UI (deviation from the original design). If they are ever exposed, the contracts are in this table.

### 5.4 Video 🎬 — `generate_video.json` / `generate_video_wan22.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| Model dropdown (Wan 2.1 / 2.2) | `model_version` (wan21 / wan22) | workflow file selection + `Load Diffusion Model`(s) |
| 📁 Upload / 🔗 previous | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🎞️ Frames (81–161, 4n+1) | `length` (4n+1 snap) | `WanImageToVideo` |
| 👣 Steps (4–10) | `steps` (wan22: odd→even) | `KSampler` (title "KSampler", class KSamplerAdvanced) |
| 🌱 Seed + 🎲 | `seed` (🎲 → -1/random) | `EasySeed` |
| Negative Prompt | `negative_prompt` (overrides default) | `Negative Prompt` |
| Modal: Diffusion model (JSON) | `diffusion_model` (object wan21 / array wan22 with `path`) | `Load Diffusion Model`(s) per `path` (high/low) |
| Modal: LoRA config (JSON) | `lora_config` (supports `path` high/low) | `Power Lora Loader (rgthree)` (filtered per path) |
| Modal: Video base URL | `comfyui_image_base_url` | — |
| Prompt (bottom bar) | `prompt` (motion) | `Positive Prompt` |

Other nodes (wan21 and wan22): `CLIPLoader (GGUF)`, `WanImageToVideo`, `KSamplerAdvanced`, `WanVideoNAG` ("NAG HIGH"), `ModelSamplingSD3`, `SageAttention`, `VAE Decode`, `Frame Interpolate`, `RTX Video Super Resolution`, `Image Blend`, `Unsharpen mask`, `CLIP Vision Encode`; output: `Output MP4` (VHS_VideoCombine). Wan 2.2 adds the dual high/low path (two `Load Diffusion Model`, two `KSampler`, model sampling shifts).

**Model config** (same as `generate_video/tool.py` + README):
- **Wan 2.1**: single path — `Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v-nvfp4.safetensors`, sampler euler, scheduler simple, steps 4, cfg 1.0, shift 5.
- **Wan 2.2**: dual high/low path — `Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-{high,low}-nvfp4.safetensors`; high: heun, start 0 / end 2, add noise; low: euler, start 2 / end 10000, no noise.

**Frames guardrail**: `_MIN_FRAMES=81`, `_MAX_FRAMES=161`, only 4n+1 valid; snap with `((n-1)//4)*4+1` (clamped). **Steps guardrail**: 4–10; wan22 rounds odd→even.

## 6. Chaining (context between tools)

- `last_result_url` (per session): the output URL of the last generation, built as `{base_url}/view?filename=...&type=output`.
- Consumers: 📋 (copy) and 🔗 (use as source in Edit/Upscale/Video).
- When consumed as a source, pass the **filename** (not the full URL) to the `Load Image (URL/Path)` node; for external URLs pass the URL directly (scheme+netloc auto-detection, like the tools).
- The mockup clears `last_result_url` on tab switch — keep that behavior unless decided otherwise.

## 7. Global config (settings)

Equivalent to the Open WebUI **AdminValves**. Configured from the 🎨 dropdown (Server URL, Image base URL, theme) and the advanced modal defaults:

| Setting | Default | UI |
|---|---|---|
| server_url | `http://localhost:8188` | 🎨 dropdown |
| image_base_url | derived from the server | 🎨 dropdown + per-tab modal |
| theme | dark | 🎨 dropdown |
| model_family (admin) | zit | settings (or modal) |
| lora_config (admin / system) | `[]` | settings |
| diffusion_model (video) | `""` (built-in defaults) | settings/modal |

## 8. State and session

- Per-tab parameter state, independent; persists across tab switches (Gradio: keep components mounted in hidden tabs or state in `gr.State`).
- The advanced modal persists its values per tab for the session.
- Reset (↺) restores defaults and clears the tab's output.
- Each tab's result persists for the session (not lost on tab switch).

## 9. Gaps and open decisions (summary)

1. **Seed in Edit** — the mockup has it; the reference `edit_image` does not. → Decide: expose it (inject into `KSampler`) or remove the UI control.
2. **Seed in Upscale** — the mockup has it; the reference `upscale_image` uses a fixed `seed: 0`. → Decide: inject into `SeedVR2 Video Upscaler` or remove the UI control.
3. **Unreachable advanced modal in Edit/Upscale** — the mockup defines the configs but there is no gear. → Decide: add a gear (deviate from the mockup) or drop the configs.
4. **Resolution / blend / color in Upscale** — live in the workflow but not in the UI; if exposed, use the §5.3 contracts.
5. **Edit LoRAs** — only in the modal; the UI has no dynamic list.
6. **Nodes with title != class** — `KSampler` (class KSamplerAdvanced) and `Output MP4` (VHS_VideoCombine) in video; always resolve by `_meta.title`.
