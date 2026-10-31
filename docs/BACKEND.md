# Backend Design — Comfy Tools

> **Implementation reference: the tools in `../../open-webui-comfy-tools`** (`smart_generate_image/`, `edit_image/`, `upscale_image/`, `generate_video/`). Our backend reimplements their behavior (workflow injection, parameter semantics, ComfyUI REST) without Open WebUI plumbing.
>
> The contract with the UI is `docs/FRONTEND.md`; here every UI control maps to a backend parameter and a workflow node.

## 1. Architecture

| Module | Responsibility |
|---|---|
| `server.py` | FastAPI app: renders the modular UI (`templates/` + `static/`) + the REST API that calls `tools/`; proxies results via `/media` |
| `comfy_client.py` | ComfyUI REST client: queue, polling, upload, output URLs |
| `tools/` | One module per tool: workflow JSON loading + parameter injection by node title |
| `workflows/` | The workflow JSONs imported from `../../open-webui-comfy-tools` |

## 2. ComfyUI integration (comfy_client.py)

1. **Submit**: `POST /prompt` with the (API-format) workflow and injected parameters.
2. **Poll**: `GET /history/{prompt_id}` until the prompt completes; handle timeout and `POST /interrupt` on cancel.
3. **Upload**: `POST /upload/image` (multipart) for user-uploaded source images in Edit/Upscale/Video; the resulting filename feeds the `Load Image (URL/Path)` node.
4. **Results**: the public URL is `{COMFYUI_MEDIA_BASE_URL}/view?filename=...&type=output`. Images from `SaveImage`/`Random Preview Image`; videos from `VHS_VideoCombine` (`Output MP4`). The same-origin `/media` proxy **streams** and honors the `Range` header (returns 206 for partials, passes `Content-Range`/`Accept-Ranges`) so the `<video>` element can seek/buffer progressively.
5. **Config**: server URL (`COMFYUI_BASE_URL`, default `http://192.168.1.8`), media base URL (`COMFYUI_MEDIA_BASE_URL`, default: derived from the server URL), optional API key.

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

### Live progress + per-step previews (B5)
- `comfy_client.queue_prompt` **materializes the client_id** (random when not
  given) and fires module-level **prompt hooks** (`register_prompt_hook`,
  called with `(client_id, prompt_id, workflow)`).
- `server.py` registers a hook that spawns a **daemon thread per job**: it
  opens a WebSocket to ComfyUI with the **same clientId** used for
  `POST /prompt`, follows that prompt's events
  (`executing`/`progress`/`executed`/`execution_success`/
  `execution_error`) and updates an in-memory `_jobs` store (stage, node,
  node_title, value/max, done, error). On `execution_error` the job is
  marked done with the ComfyUI message in `job["error"]`; on `executed` of
  the Face swap workflow's extracted-face node ("Random Preview Image
  (face)") the output image is captured as `job["face_preview"]` (a
  same-origin `/media` path — the node executes BEFORE the sampling, so
  the extraction is visible mid-run). The WS is best-effort: if it fails,
  the existing `wait_for_output` polling still completes the job.
- `GET /api/progress` exposes the most recent active job — it is the payload
  source for the /ws/progress push and stays as the polling fallback.
  Payload variants: `{active: {...}}` while running (with `preview` and, for
  Face swap, `face_preview`), `{active: null}` when it settled cleanly, and
  `{active: null, error}` when it ended in a **ComfyUI execution error** —
  terminal, the UI stops waiting immediately (no result will ever come).
- **Push to the browser**: every `_jobs` mutation (queued, stage, step
  value/max, per-step preview, completion) is broadcast over **`/ws/progress`**
  (`_broadcast_progress` + `_progress_payload` in `server.py`): the
  broadcaster is thread-safe (updates from the ComfyUI listener threads land
  on the event loop via `call_soon_threadsafe` into per-client queues, and a
  sender task per connection serializes the sends). The frontend connects on
  job start, receives a snapshot immediately and every update as it happens
  — **no more 1s polling**; if the WS fails it falls back to polling
  `/api/progress` (same payload shape, same painter).
- **Live per-step previews** (Generate, Edit/Extend and Video) use the same
  mechanism the ComfyUI web UI uses — no preview node needed:
  - The tools queue with `extra_data={"preview_method": "auto"}` (the CLI
    default is NoPreviews, so without this the sampler generates no
    previews; the flag is per-prompt and auto-reset). Only Generate,
    Edit/Extend and Video opt in; Upscale (SeedVR2) does not.
  - The sampler decodes its intermediate latent each step (tiny VAE from
    `models/vae_approx`, or the built-in Latent2RGB previewer — Wan
    latents are 5D and preview their first frame) and streams JPEGs over
    the WS as **binary frames**. The listener declares support with a
    `feature_flags` handshake as its first message
    (`{"type": "feature_flags", "data": {"supports_preview_metadata": true}}`)
    and parses the frames: event 4 `PREVIEW_IMAGE_WITH_METADATA`
    (`>I(4) + >I(len_json) + JSON{node_id, prompt_id} + JPEG`) and legacy
    event 1 (`>I(4) + >I(image_type) + bytes`).
  - Only the **last preview per job** is kept (bounded memory, ~50KB); it
    is dropped when the job finishes or is cancelled (`_mark_job_result`
    pops it) so nothing stale is ever served and no memory accumulates.
  - `GET /api/progress` serves `active.preview` as a
    `data:image/jpeg;base64,…` while the job runs. For wan22 the two
    KSamplers run HIGH then LOW, so previews arrive in flow order with
    their node_id (the UI shows `KSampler HIGH v/max` then
    `KSampler LOW v/max`).
- **Cancel** (`POST /api/cancel`): `ComfyClient.interrupt()` (`POST
  /interrupt`, empty body / Content-Length 0) stops the running prompt;
  `ComfyClient.cancel_prompt(pid)` (`POST /queue` `delete`) removes the
  pending one; the job is marked done so progress goes idle.
- **Execution errors fail fast**: `wait_for_output` polls
  `GET /history/{pid}` and now detects `status.status_str == "error"`
  (the `execution_error` messages carry e.g. CUDA OOM) — it raises
  `ComfyError` with the ComfyUI message instead of polling until the
  timeout, so the tool endpoints surface the failure as a terminal **400**
  in seconds. A plain `TimeoutError` (the backend's own wait ran out but
  ComfyUI may still be running) maps to **408** so the frontend keeps the
  recovery path.
- Verified live: `queued` → `SamplerCustomAdvanced 1/8..8/8` → `VAE Decode`
  → `Random Preview Image` → done; `/interrupt` and `/queue delete` both
  return 200 on the live server; per-step previews confirmed for flux2,
  krea2 and wan21.

## 3. Workflow injection pattern (tools/)

Identical to the Open WebUI tools: load the JSON, resolve each node by its **unique `_meta.title`** and override `inputs`. The titles used are the same as in `../../open-webui-comfy-tools` (listed in the contract tables of §5).

The Generate builders share a common trunk through the `_inject_model_stack`,
`_inject_resolution`, `_inject_prompt`, `_inject_variability_conditioning` and
`_inject_loras` helpers in `tools/generate.py`; each builder keeps only the
technique-specific nodes (steps/scheduler/sampler/seed).

Workflow JSONs are copied from `../../open-webui-comfy-tools/<tool>/` into `workflows/` (unmodified unless documented).

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
| Model family dropdown | `family` (zimage / krea2 / flux2) | `Load Diffusion Model`, `Load CLIP`, `Load VAE` (models from the family config) |
| W/H readonly (auto) | `megapixel` + `aspect_ratio` (w:h) | `Flux Resolution Calc` |
| AR dropdown | `aspect_ratio` (w:h) | `Flux Resolution Calc` |
| 📐 MP stepper | `megapixel` (0.1–2.0) | `Flux Resolution Calc` |
| 👣 Steps (auto per family) | `steps` (1–50; 0 = family default) | `Steps` (via `BasicScheduler`) |
| 🌱 Seed + 🎲 | `seed` (0…2^64−1; 🎲 → random en cliente) | `RandomNoise` |
| LoRAs (advanced modal: `LoRA config (JSON)`) | `lora_config` | `Power Lora Loader (rgthree)` |
| Prompt (bottom bar) | `prompt` | `Prompt` → `CLIP Text Encode (Prompt)` |
| Modal: Model name | `model` (.safetensors, overrides the family default) | `Load Diffusion Model` |
| Modal: **Increase randomness** (Z-Image Turbo / Krea 2 / FLUX.2) | `variability` (bool) | selects `dit_var.json` (Z-Image/Krea 2) or `flux2_var.json` (FLUX.2) instead (see below) |

Other relevant nodes: `SamplerCustomAdvanced`, `KSamplerSelect`, `CFGGuider`, `Switch (SIGMAS)`, `VAE Decode`; output: `Random Preview Image`.

**Family config** (single source: `FAMILY_CONFIGS` in `tools/generate.py`;
`MODEL_CONFIGS` is the derived standard view):

| Family | Model | Text encoder | VAE | vae_scale | cfg | steps | sampler | scheduler |
|---|---|---|---|---|---|---|---|---|
| Z-Image Turbo | zImageTurbo-mxfp8.safetensors | qwen3_4b_instruct_2507_mxfp8 | Z-Image_half_natural_vae | 16 | 1.0 | 9 | euler | simple |
| Krea 2 | krea2_turbo_mixed_nvfp4 | qwen3_vl_4b_instruct_mxfp8 | qwen_image_vae | 16 | 1.0 | 8 | euler | simple |
| FLUX.2 Klein | flux-2-klein-9b-nvfp4 | qwen_3_8b_nvfp4 | flux2-vae-small-bf16 | 16 | 1.0 | 8 | euler | (flux.2) |

`steps` accepts **1–50** (`MIN_STEPS` / `MAX_STEPS`). The ceiling covers
undistilled checkpoints: FLUX.2 \[klein] Base is not step-distilled and BFL
recommends ~50 steps for it, while the distilled families here default to 8–9.
The GUI's `👣 Steps` stepper uses the same bounds (`MIN_GEN_STEPS` /
`MAX_GEN_STEPS` in `static/js/state.js`), so a value the user can pick reaches
the workflow unchanged.

**Increase randomness (Z-Image Turbo / Krea 2 / FLUX.2)**

When the advanced checkbox is on (and the family supports it), the request
builds a two-stage variability workflow instead of `smart_generate_image.json`
(`build_variability_workflow` in `tools/generate.py`):

- **Z-Image Turbo / Krea 2** → `workflows/dit_var.json`. The first step runs
  with `res_multistep` + `ModelSamplingAuraFlow` shift 7 while its prompt is
  suppressed for the first timestep slice (`ConditioningSetTimestepRange` +
  `ConditioningCombine`); the rest continues with `euler` + shift 2.5.
- **FLUX.2** → `workflows/flux2_var.json`. One `Flux2Scheduler` feeds
  `SplitSigmas(step=1)`: stage 1 takes the high sigmas (1 step,
  `res_multistep`, shift 7) and stage 2 the low sigmas (N-1 steps, `euler`,
  shift 2.5). Stage 2 continues from stage 1's latent with `DisableNoise`, so
  it follows the same schedule without adding new noise. Stage 1 uses the
  timestep-gated conditioning exactly like `dit_var.json`.

Removing the prompt's lock on the very first step makes the seed change the
image far more than the single-stage workflow. Per-family knobs
(`FAMILY_CONFIGS[family]["variability"]`; `VARIABILITY_CONFIGS` is the derived
view):

| Family | Workflow | Model / text encoder / VAE | default steps | threshold | divisible_by |
|---|---|---|---|---|---|
| Z-Image Turbo | `dit_var.json` | zImageTurbo-mxfp8 / qwen3_4b_instruct_2507_mxfp8 / Z-Image_half_natural_vae | 10 | 0.105 | 16 |
| Krea 2 | `dit_var.json` | krea2_turbo_mixed_nvfp4 / qwen3_vl_4b_instruct_mxfp8 / qwen_image_vae | 9 | 0.112 | 16 |
| FLUX.2 Klein | `flux2_var.json` | flux-2-klein-9b-nvfp4 / qwen_3_8b_nvfp4 / flux2-vae-small-bf16 | 8 | 0.13 | 16 |

Why 16: the official Krea-2 inference code aligns width/height to a multiple
of 16 (Qwen-Image VAE 8× × Krea-2 patch size 2), and FLUX.2 uses a 16× VAE
with `patch_size=1` (BFL/ComfyUI require multiples of 16). ComfyUI's Krea-2
template uses `multiple=8`, which works because the model pads odd latents
internally; this project aligns both the standard and variability paths to 16
to avoid that padding.

**dit_var mapping** (Z-Image Turbo / Krea 2):

| UI control | Backend parameter | Workflow node (title) |
|---|---|---|
| Prompt | `prompt` | `Prompt here` |
| AR dropdown | `aspect_ratio` (w:h) | `Aspect ratio` (`StringConcatenate`) |
| MP stepper | `megapixel` (0.1–2.0) | `Flux Resolution Calc` |
| Steps (auto per family) | `steps` | `KSampler (Advanced) 1` **and** `2` (same value) |
| Seed + 🎲 | `seed` | `KSampler (Advanced) 1` **only** |
| LoRAs | `lora_config` | `Power Lora Loader (rgthree)` (feeds stage 2 only — deliberate) |
| Model name | `model` | `Load Diffusion Model` |
| Modal: Initial conditioning | `initial_conditioning` | `Initial conditioning` (replaces the prompt conditioning for the first timestep slice; `""` keeps the original behaviour) |
| — (per family) | — | `ConditioningTimestepThreshold` (`90:93`): 0.105 (Z-Image) / 0.112 (Krea 2) |
| — (fixed in JSON) | — | `KSampler (Advanced) 2` seed: ComfyUI ignores `noise_seed` with `add_noise: disable`, so it stays 0 |

**flux2_var mapping** (FLUX.2 Klein):

| UI control | Backend parameter | Workflow node (title) |
|---|---|---|
| Prompt | `prompt` | `Prompt here` |
| AR dropdown | `aspect_ratio` (w:h) | `Aspect ratio` (`StringConcatenate`) |
| MP stepper | `megapixel` (0.1–2.0) | `Flux Resolution Calc` |
| Steps (total) | `steps` | `Flux2Scheduler` (the graph splits it 1 + N-1 via `SplitSigmas step=1`) |
| Seed + 🎲 | `seed` | `RandomNoise` (stage 1; stage 2 uses `DisableNoise`) |
| LoRAs | `lora_config` | `Power Lora Loader (rgthree)` (feeds stage 2 only — deliberate) |
| Model name | `model` | `Load Diffusion Model` |
| Modal: Initial conditioning | `initial_conditioning` | `Initial conditioning` (used by stage 1) |
| — (per family) | — | `ConditioningTimestepThreshold`: 0.13 |

FLUX.2 writes the seed to `RandomNoise.noise_seed` and preserves the full
uint64 range. Every tool preserves the max of its target node (uint64 for
RandomNoise/KSampler, `2^50` for EasySeed, uint32 for SeedVR2). Stage 2 uses
`DisableNoise`, so it has no seed of its own.

The sampler/scheduler/shift/cfg and the model routing (stage 1 uses the raw
UNET, stage 2 the LoRA-adjusted one) are **fixed by the technique** and are
never overridden. `variability` with any other family is rejected (`400`).

### 5.2 Edit ✏️ — `edit_image.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 📁 Upload / 🔗 previous / URL field | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🖌️ Edit / 🩹 Restore (buttons) | `mode` ("edit" / "restore") | restore: appends `Flux2-Klein-Image-RestoreV1.safetensors` to `Power Lora Loader (rgthree)` + restoration prompt prefix |
| 👣 Steps | `steps` (1–15, default 6) | `Flux2Scheduler` |
| 🌱 Seed + 🎲 | `seed` (0…2^64−1; 🎲 → random en cliente) | `RandomNoise` |
| Modal: LoRA config | `lora_config` | `Power Lora Loader (rgthree)` |
| Prompt (bottom bar; optional in restore) | `prompt` | `Prompt` |

Sampling uses the **FLUX.2 guidance stack** (replacing the generic `KSampler`): `SamplerCustomAdvanced` + `Flux2Scheduler` (steps) + `CFGGuider` (cfg 1) + `KSamplerSelect` (euler) + `RandomNoise` (seed). The negative conditioning is the `ConditioningZeroOut` of the positive `ReferenceLatent` (no separate negative ReferenceLatent). The output goes **directly from `VAE Decode` to `Random Preview Image`** — the previous `Upscale Image (using Model)` / `Load Upscale Model` (1xSkinContrast) stage was removed, so the result is no longer upscaled/skin-contrasted.

Other nodes: `Load Diffusion Model` (flux-2-klein), `Load VAE`, `VAE Encode/Decode`, `ReferenceLatent`, `Empty Flux 2 Latent`, `ImageScaleToTotalPixels`, `GetImage_(Width&Height) _O` (feeds `Flux2Scheduler`), `ConditioningZeroOut`, `Concatenate`; output: `Random Preview Image`.

**✅ Seed supported**: the reference `edit_image/tool.py` exposes `seed` since v1.6 (UserValve, -1 = random, ≥0 = fixed, injected into `RandomNoise.noise_seed`).

### 5.2.1 Extend 🧩 — `extend_image.json`

`POST /api/edit` with `mode="extend"` dispatches to `tools/extend.py` instead
of the Edit builder. It uses the **same FLUX.2 Klein 9B stack** as Edit, so
there is no model selector or separate tab.

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 📁 Upload / 🔗 previous / URL field | `image` (filename or URL) | `Load Image (URL/Path)` |
| ⛶ chip: ⬆️ Top | `top` (0–1024 px) | `Pad Image for Outpainting` → `top` |
| ⛶ chip: ⬇️ Bottom | `bottom` (0–1024 px) | `Pad Image for Outpainting` → `bottom` |
| ⛶ chip: ⬅️ Left | `left` (0–1024 px) | `Pad Image for Outpainting` → `left` |
| ⛶ chip: ➡️ Right | `right` (0–1024 px) | `Pad Image for Outpainting` → `right` |
| ⛶ chip: 🪶 Feathering | `feathering` (0–256, default 40) | `Pad Image for Outpainting` → `feathering` |
| Prompt (bottom bar; optional) | `prompt` | `Prompt` (`StringConcatenate`); appends after the built-in `"remove the green part"` |
| 👣 Steps | `steps` (1–15, default 6) | `Flux2Scheduler` |
| 🌱 Seed + 🎲 | `seed` (0…2^64−1) | `RandomNoise` |
| Modal: LoRA config | `lora_config` | `Power Lora Loader (rgthree)` |

Validation: all four paddings are integers in `[0, 1024]`; at least one edge
must be greater than 0; feathering is an integer in `[0, 256]`; `steps` uses
the same `[1, 15]` range as Edit.

**Workflow path**: the source is scaled to 1.5 MP, padded (`ImagePadForOutpaint`),
masked green (`DrawMaskOnImage`), scaled to the ~1 MP working size, encoded
and sampled with the FLUX.2 guidance stack. `ColorMatch` restores the source
coloring. The padding values are pixels of the **1.5 MP working canvas**, not
of the original image.

**Output size (automatic)**: when the source is larger than 1 MP, the
workflow measures the original, pre-padding and padded sizes and adds a final
`ImageScale` (`lanczos`) that restores the **source pixel density on the
extended canvas**:

```
target_width  = original_width  * padded_width  / pre_pad_width
target_height = original_height * padded_height / pre_pad_height
```

The branch is selected with `ImpactCompare` + `easy imageSwitch`; sources
≤ 1 MP keep the existing ~1 MP output. Final sides are clamped to 16384 px.

Other nodes: `ImageScaleToTotalPixels`, `GetImageSize`, `EmptyFlux2LatentImage`,
`VAE Encode/Decode`, `ReferenceLatent`, `ConditioningZeroOut`,
`SamplerCustomAdvanced`, `CFGGuider`, `KSamplerSelect`, `ColorMatch`; output:
`Random Preview Image`.

### 5.3 Upscale 🔍 — `seedvr2_upscale.json`

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 📁 Upload / 🔗 previous / URL field | `image` (filename or URL) | `Load Image (URL/Path)` |
| 🌱 Seed + 🎲 | `seed` (0…2^32−1; 🎲 → random en cliente) | `SeedVR2 Video Upscaler (v2.5.24)` |
| — (no control) | `resolution` 2048 | `SeedVR2 Video Upscaler` |
| — (no control) | `color_correction` "lab" | `SeedVR2 Video Upscaler` |
| — (no control) | `blend_factor` 0.15 | `Image Blend` |

Other nodes: `SeedVR2 (Down)Load DiT Model` → **`SeedVR2LoadDiTModel`**, `SeedVR2 (Down)Load VAE Model` → **`SeedVR2LoadVAEModel`**, `SeedVR2 Video Upscaler (v2.5.24)` → **`SeedVR2VideoUpscaler`** (exact names confirmed on the dev server; `dev/check_env.py` validates them); output: `Random Preview Image`.

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
| 👣 Steps (4–10) | `steps` (wan22: odd→even) | `KSampler` (wan21, title "KSampler") / `KSampler HIGH` + `KSampler LOW` (wan22, class KSamplerAdvanced) |
| 🌱 Seed + 🎲 | `seed` (0…2^50; 🎲 → random en cliente) | `EasySeed` |
| Negative Prompt | `negative_prompt` (overrides default) | `Negative Prompt` |
| Modal: Diffusion model (JSON) | `diffusion` (object wan21 / array wan22 with `path`) | `Load Diffusion Model`(s) per `path` (high/low) |
| Modal: LoRA config (JSON) | `lora_config` (supports `path` high/low) | `Power Lora Loader (rgthree)` (filtered per path) |
| Prompt (bottom bar) | `prompt` (motion) | `Positive Prompt` |

Other nodes (wan21 and wan22): `CLIPLoader (GGUF)`, `WanImageToVideo`, `KSamplerAdvanced`, `WanVideoNAG` ("NAG HIGH"), `ModelSamplingSD3`, `SageAttention`, `VAE Decode`, `Frame Interpolate`, `RTX Video Super Resolution`, `Image Blend`, `Unsharpen mask`, `CLIP Vision Encode`; output: `Output MP4` (VHS_VideoCombine). Wan 2.2 adds the dual high/low path (two `Load Diffusion Model`, two `KSampler`, model sampling shifts).

**Model config** (same as `generate_video/tool.py` + README):
- **Wan 2.1**: single path — `Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v-nvfp4.safetensors`, sampler euler, scheduler simple, steps 4, cfg 1.0, shift 5.
- **Wan 2.2**: dual high/low path — `Wan2.2-I2V-A14B-Moe-Distill-Lightx2v-{high,low}-nvfp4.safetensors`; high: heun, start 0 / end 2, add noise; low: euler, start 2 / end 10000, no noise.

**Frames guardrail**: `_MIN_FRAMES=81`, `_MAX_FRAMES=161`, only 4n+1 valid; snap to the **nearest** 4n+1: `snapped = ((n-1)//4)*4+1`, then `snapped += 4` when `n - snapped > 2` (clamped) — exact mirror of `_snap_to_valid_frames` in `generate_video/tool.py`; the mockup implements the same logic (`snapVideoFrames`). **Steps guardrail**: 4–10; wan22 rounds odd→even.

### 5.5 Face swap 👨🏻 — `face_swap.json`

Own workflow (not imported from `../../open-webui-comfy-tools`). The
head-swap logic (face segmentation → mask → crop → alpha → reference
latents) is fixed inside the JSON; the tool only injects the two sources,
the sampling parameters and the optional extra prompt.

| UI control (FRONTEND) | Backend parameter | Workflow node (title) |
|---|---|---|
| 🖼️ Base image (upload / 🔗 / URL) | `image` (filename or URL) | `Load Image (URL/Path)` |
| 👨🏻 Face image (upload / URL) | `face` (filename or URL) | `Face Reference` |
| Prompt (optional) | `prompt` (appended after the built-in head-swap instructions) | `Prompt` → `Concat Prompt (Positive)` (StringConcatenate) |
| 🎚️ CFG (guidance) | `cfg` (0–8, step 0.1; 0 = no guidance) | `CFG Guider` |
| 👣 Steps | `steps` (1–15, default 6) | `Flux2Scheduler` |
| 🌱 Seed + 🎲 | `seed` (0…2^64−1; 🎲 → random en cliente) | `RandomNoise` |
| — (runtime) | dedicated head-swap LoRA | `Load LoRA` (name resolved against `GET /models/loras`) |

The workflow ends in TWO preview outputs — the swapped result (`Random
Preview Image`) and the extracted-face crop (`Random Preview Image
(face)`). Because the crop node runs BEFORE the sampler, the backend can
record its image early (see §2) and return it as `face_preview` on
`POST /api/face-swap` and `/api/last-result`.

### 5.6 Seed handling 🔢 — per-workflow

Each workflow stores the seed in a different node. The builders call
`_common.resolve_seed(seed, max_value=...)` with the max accepted by that
node, so a manually entered seed is never clamped more than necessary
(`seed == -1` generates a random value inside the same range). The API
resolves `-1`/the clamp before calling the tool and returns the exact injected
seed as a string (JSON numbers would lose precision in the browser).

| Workflow | Seed node (title) | Parameter | Max |
|---|---|---|---|
| `smart_generate_image.json` | `RandomNoise` | `noise_seed` | uint64 (`2^64−1`) |
| `dit_var.json` | `KSampler (Advanced) 1` | `noise_seed` | uint64 |
| `flux2_var.json` | `RandomNoise` | `noise_seed` | uint64 |
| `edit_image.json` | `RandomNoise` | `noise_seed` | uint64 |
| `face_swap.json` | `RandomNoise` | `noise_seed` | uint64 |
| `generate_video.json` / `generate_video_wan22.json` | `EasySeed` | `seed` | `2^50` (`1125899906842624`) |
| `seedvr2_upscale.json` | `SeedVR2 Video Upscaler (v2.5.24)` | `seed` | uint32 (`4294967295`) |

Notes:
- `dit_var.json` injects the seed only into stage 1; `KSampler (Advanced) 2`
  keeps `noise_seed=0` with `add_noise: disable`.
- `flux2_var.json` injects into `RandomNoise` (stage 1); stage 2 uses
  `DisableNoise` and has no seed.
- Video uses one `EasySeed` node whose output feeds both KSamplers (wan22) or
  the single sampler (wan21).
- The frontend keeps seeds as **decimal strings** and parses/validates them
  with `BigInt` (`static/js/seed.js`): uint64 stays exact, unlike JS
  `Number` (safe only to `2^53−1`). The seed inputs are text fields, not
  `type="number"`.
- The 🎲 generates a random value in the target node's full range
  client-side (uint64 / `2^50` / uint32) and shows it in the field. Manual
  seeds must be `0…max`; `-1` is only the API/CLI random sentinel.
- The `/api/*` responses include the resolved `seed` (always a string) so a
  clamped or server-resolved value can never disagree with the executed
  workflow.

## 6. Chaining (context between tools)

- `lastGeneratedUrl` (per session): the output URL of the last IMAGE
generation (generate / edit / restore / face swap / upscale), built as
`{COMFYUI_MEDIA_BASE_URL}/view?filename=...&type=output`. **Persists across
  tab switches** so it can be used after generating in another tab.
- Consumers: 📋 (copy — click the hint URL) and 🔗 (fills the source URL
  field of Edit/Upscale/Video — and the **base** field of Face swap — with
  `lastGeneratedUrl`).
- Videos never become `lastGeneratedUrl`: all three consumers need an IMAGE
  source (img2img / img2vid), so a generated video is never chainable. In a
  session, `video.js`/`finalizeRecoveredJob` only record the URL in the
  video gallery, not in `lastGeneratedUrl`; after a refresh,
  `restoreLastGeneratedUrl` rebuilds it exclusively from
  `galleryGenerated` (never `galleryVideos`).
- The source URL field is the tool's `image` input: paste an external URL directly, or use 🔗/📁. When consumed as a source, pass the **filename** (not the full URL) to the `Load Image (URL/Path)` node; for external URLs pass the URL directly (scheme+netloc auto-detection, like the tools).
- If the field is empty on generate, the app should prompt for a source (upload via 📁, use 🔗, or paste a URL).

## 7. Global config (settings)

Global, not per-tool: there is exactly one server URL, one media base URL (`COMFYUI_MEDIA_BASE_URL`) and
one theme for the whole app (no override layers). Configured from the 🎨
dropdown and the settings defaults; the advanced modal only holds tool-level
fields (model, LoRA/diffusion config):

| Setting | Default | UI |
|---|---|---|
| server_url | `http://192.168.1.8` | 🎨 dropdown |
| COMFYUI_MEDIA_BASE_URL | derived from the server | 🎨 dropdown |
| theme | dark | 🎨 dropdown |
| model_family | zimage (backend) / krea2 (UI default) | settings / toolbar |
| lora_config (default) | `[]` | settings |
| diffusion_model (video) | `""` (built-in defaults) | modal (Video) |
| prompt_refiner_base_url | `""` (🪄 disabled) | 🎨 dropdown |
| prompt_refiner_model | `""` (auto = first non-excluded model) | 🎨 dropdown (🤖) |
| prompt_refiner_system_prompt | default system prompt | 🎨 dropdown |

### 7.1 Refiner model resolution (llama.cpp router)

The 🪄 refiner targets a llama.cpp **router** (one endpoint, several
models). Every chat request must carry a valid `model` name — the router
rejects requests without it (`400 model name is missing`) or with an
unknown id (`400 model 'x' not found`).

- `prompt_refiner.py::list_models()` — `GET {base}/v1/models` on the
  router; returns the served model ids (used by `GET /api/refiner-models`).
- `prompt_refiner.py::resolve_model()` — precedence:
  1. the model id in the request body (if provided),
  2. `settings.prompt_refiner_model` (what the 🤖 selector persists),
  3. **auto**: the first model from the router's list that does NOT match
     any substring in `settings.refiner_exclude` (env `REFINER_EXCLUDE`,
     comma-separated; default excludes the 9B models so refinement never
     lands on a heavy model). If all models are excluded, the first one is
     used anyway (better a model than a 400).
- The resolved model is injected into the `/v1/chat/completions` payload
  (streaming and non-streaming).

`GET /api/refiner-models` returns `{models: [id…], default: id}` where
`default` is what auto would pick (first non-excluded).

## 8. State and session

- Per-tab parameter state, independent; persists across tab switches (kept in the frontend's DOM — tabs are never rebuilt).
- Per-tab prompts (`promptsByTab`) — one prompt per generate/edit/video; Upscale has none. Saved/restored on tab switch and persisted to localStorage.
- The advanced modal persists its values per tab for the session.
- Reset (↺) restores defaults, clears the tab's output and cancels any running job (see `cancelIfRunning`).
- Each tab's result persists for the session (not lost on tab switch).
- Session galleries (frontend), **persisted to localStorage**:
  `window.galleryGenerated` (generations + transformations),
  `window.galleryComparisons` (edited/restored/upscaled before/after pairs)
  and `window.galleryVideos` (generated videos) — see docs/FRONTEND.md §7.

## 9. Implementation notes

1. **LoRAs are managed exclusively via the advanced modal** (the visual row
   editor in Generate/Edit/Video — it derives the backend `lora_config`
   JSON array on save); there is no dynamic list in the params pane.
   `override_system_loras` does not exist (no override layers).
2. **Nodes with title != class** — `KSampler` (class KSamplerAdvanced) and `Output MP4` (VHS_VideoCombine) in video; always resolve by `_meta.title`.
3. **Cache busting** — static assets are served with `Cache-Control: no-cache` (revalidate, `NoCacheStaticFiles`) AND versioned in the HTML shell (`?v=<hash>` from `ASSET_VERSION`, a sha1 of static path+mtimes), so a browser reload always runs the current JS/CSS. The HTML itself is `Cache-Control: no-store` — a stale index could pin old `?v=` URLs.
