# PLAN — gradio-comfy-tools

Implementación por fases del proyecto (spec en `FRONTEND.md` / `BACKEND.md`, UI en
`mockup.html`, workflows en `workflows/`). El plan tiene **dos partes**:

- **Parte A — Backend** (este documento, §A0–A6): infraestructura ComfyUI + un
  tool por pestaña. Cada pestaña se **valida manualmente** contra el servidor
  (default `http://192.168.1.8`) antes de pasar a la siguiente.
- **Parte B — Frontend** (pendiente): la app Gradio (`app.py`) que consume los
  tools. Se escribirá a partir de la Parte A terminada, reutilizando su contrato.

Cada fase de la Parte A termina con un bloque **Validación manual**: pasos
concretos y resultado esperado. No se avanza a la siguiente fase hasta que el
usuario lo valida.

---

# Parte A — Backend

## A0. Fundaciones (infraestructura común)

### Objetivo
Base reutilizable por las 4 pestañas: cliente REST de ComfyUI, configuración y
helpers de inyección de workflows. Se entrega con tests y un smoke test real
contra el servidor.

### Archivos
| Archivo | Contenido |
|---|---|
| `config.py` | `Settings`: `comfyui_base_url` (default `http://192.168.1.8`), `comfyui_media_base_url` (derivada de la base), `api_key` (opcional). Carga de env + override en runtime (para el 🎨 de settings). |
| `comfy_client.py` | Cliente REST **sync** (`httpx.Client`), sin dependencia de Gradio. |
| `tools/_common.py` | `resolve_node(workflow, title)` (por `_meta.title` único), helpers de inyección (seed, steps, lora_config, snap frames), auto-detección filename-vs-URL. |
| `tests/test_comfy_client.py` | Tests con `httpx.MockTransport` (sin servidor). |
| `scripts/smoke_client.py` | Smoke test real: health → upload → queue de un workflow trivial → poll → URL. |

### Contrato REST (validado contra ComfyUI 0.29.1 en 192.168.1.8)
| Método/endpoint | Uso | Respuesta |
|---|---|---|
| `GET /system_stats` | health | JSON con `system.comfyui_version` |
| `POST /upload/image` | subir archivo local (multipart) → `type=temp` | `{"name": "<filename>", ...}` |
| `POST /prompt` | encolar workflow `{"prompt": {...}, "client_id": "<uuid>"}` | `{"prompt_id": "<id>"}` |
| `GET /history/{prompt_id}` | poll hasta que `outputs` no vacío (1s, timeout configurable, default 120s) | outputs del prompt |
| `GET {media_base}/view?filename=...&type=output` | URL pública del resultado | — |

Decisiones: **sync** (Gradio ejecuta handlers en threads; la ref es async porque
Open WebUI lo exige, aquí no) y **polling por history** (igual que la ref, sin
depender de websocket).

### Validación manual (A0)
```
python3 scripts/smoke_client.py            # usa COMFYUI_BASE_URL o el default
```
Esperado: `health OK (ComfyUI 0.29.1)` → sube una imagen de prueba → encola un
workflow mínimo → imprime la URL `/view?...`. El usuario abre la URL en el
navegador y ve el resultado.

---

## A1. Pestaña Generate 🖼️ — `smart_generate_image.json`

### Objetivo
Tool `tools/generate.py` que ejecuta el workflow de Generate: selección de
familia (Z-Image Turbo, Krea 2, FLUX.2 Klein), prompt, resolución (AR + MP),
steps, seed y LoRAs. Es la primera pestaña porque define los patrones que
reutilizan las demás (resolución, seed, LoRA).

### Contrato de entrada
| Parámetro | Tipo / default | Reglas |
|---|---|---|
| `family` | select: `zimage` / `krea2` / `flux2` (default `zimage`) | fija `MODEL_CONFIGS` (modelo, clip, vae, vae_scale, cfg, steps, sampler, scheduler) |
| `prompt` | str, default "" | obligatorio en la práctica (se valida no vacío) |
| `aspect_ratio` | str "W:H" | normalizada por GCD; default 2:3 |
| `megapixel` | float, default 1.0 | controla resolución total (independiente del AR) |
| `steps` | int, default: de la familia (0 = default) | 1–15 |
| `seed` | int, default -1 | -1 = random |
| `lora_config` | JSON array (opcional) | slots `lora_1..lora_4` del Power Lora Loader |

### Inyecciones por nodo (títulos del workflow)
| Nodo (`_meta.title`) | Se escribe |
|---|---|
| `Load Diffusion Model` (UNETLoader) | `unet_name` según familia |
| `Load CLIP` (CLIPLoader) | `clip_name` según familia |
| `Load VAE` (VAELoader) | `vae_name` según familia |
| `Prompt` (PrimitiveStringMultiline) | `value` = prompt |
| `Flux Resolution Calc` | `megapixel`, `divisible_by` = `vae_scale_factor` (16/8/64) |
| `Aspect ratio` (StringConcatenate) | `string_a`/`string_b` = W:H reducidos (GCD + MP) |
| `Steps` (easy int) | `value` = steps |
| `RandomNoise` / `KSamplerSelect` | `noise_seed` / sampler según familia |
| `Power Lora Loader (rgthree)` | activa `lora_1..4` según `lora_config` |

### Validación manual (A1)
CLI `scripts/run_generate.py --family zimage|krea2|flux2 --prompt "..." [--ar 16:9] [--mp 1.0] [--steps 8] [--seed -1]`.
Pasos: generar con **cada familia**, con AR 2:3 y 16:9, con seed fijo (repetir →
misma imagen) y con LoRA real del servidor (p. ej. `flux2/Flux2-Klein-Image-RestoreV1.safetensors` en flux2).
Esperado: URL `/view?filename=ComfyUI_...png&type=output` con la imagen correcta.

---

## A2. Pestaña Edit ✏️ — `edit_image.json`

### Objetivo
`tools/edit.py`: editar/restaurar una imagen fuente (filename previo o URL
externa), con prompt, steps, seed y LoRAs.

### Contrato de entrada
| Parámetro | Tipo / default | Reglas |
|---|---|---|
| `image` | str (filename o URL) | auto-detección: `urlparse` con scheme+netloc → `source="url"`; si no → `source="temp"` (filename) |
| `mode` | `"edit"` / `"restore"` | restore: añade LoRA `flux2/Flux2-Klein-Image-RestoreV1.safetensors` + prefijo de prompt de restauración |
| `prompt` | str, default "" | opcional en restore |
| `steps` | int, default 6 | 1–15 |
| `seed` | int, default -1 | -1 = random |
| `lora_config` | JSON array (opcional) | slots del Power Lora Loader |

### Inyecciones
| Nodo | Se escribe |
|---|---|
| `Load Image (URL/Path)` | `source` + `url` / `image` (según detección); limpia `Choose file to upload` |
| `Prompt` | `value` = prompt (en restore, prefijo + prompt) |
| `KSampler` | `steps`, `seed` |
| `Power Lora Loader (rgthree)` | añade LoRA de restore + `lora_config` |

### Validación manual (A2)
CLI `scripts/run_edit.py --image <filename|URL> --mode edit|restore [--prompt "..."] [--steps 6] [--seed -1]`.
Pasos: editar una imagen subida (filename temp), editar una imagen por URL
externa, y modo restore. Esperado: imagen editada con la URL de salida correcta.

---

## A3. Pestaña Upscale 🔍 — `seedvr2_upscale.json`

### Objetivo
`tools/upscale.py`: upscale 2x de una imagen fuente. **Sin** parámetros extra
(resolución 2048, `color_correction` lab, `blend_factor` 0.15 fijos en el
workflow — decisión tomada).

### Contrato de entrada
| Parámetro | Tipo / default | Reglas |
|---|---|---|
| `image` | str (filename o URL) | auto-detección igual que Edit |
| `seed` | int, default -1 | -1 = random |

### Inyecciones
| Nodo | Se escribe |
|---|---|
| `Load Image (URL/Path)` | `source` + `url` / `image` |
| `SeedVR2 Video Upscaler` | `seed` |

### Validación manual (A3)
CLI `scripts/run_upscale.py --image <filename|URL> [--seed -1]`.
Pasos: upscale de una imagen subida y de una URL externa (2x). Esperado: imagen
ampliada (2048 en el lado mayor) con URL de salida correcta.

---

## A4. Pestaña Video 🎬 — `generate_video.json` / `generate_video_wan22.json`

### Objetivo
`tools/video.py`: imagen → vídeo con Wan 2.1 (ruta única) o Wan 2.2 (ruta dual
high/low), frames 4n+1, steps, seed, prompt y negative.

### Contrato de entrada
| Parámetro | Tipo / default | Reglas |
|---|---|---|
| `image` | str (filename o URL) | auto-detección igual que Edit |
| `model_version` | `"wan21"` / `"wan22"` | selecciona workflow + `MODEL_CONFIGS` de vídeo |
| `prompt` | str | — |
| `negative_prompt` | str, default "" | vacío → default del workflow |
| `frames` | int, default 81 | snap al 4n+1 más cercano: `snapped=((n-1)//4)*4+1; +=4 si n-snapped>2`; clamp [81,161] |
| `steps` | int, default 4 | 4–10; wan22: impar → par (redondeo arriba) |
| `seed` | int, default -1 | -1 = random |

### Inyecciones
| Nodo | Se escribe |
|---|---|
| `Load Image (URL/Path)` | `source` + `url` / `image` |
| `Load Diffusion Model` (×2 en wan22) | `unet_name` high/low según familia |
| `WanImageToVideo` | `length` (frames), `start_image` (conectado a Load Image) |
| `KSamplerAdvanced` / `KSampler` | `steps`, `seed` (wan22: dual path high/low) |
| `CLIP Text Encode (Prompt)` / `(Negative)` | prompt / negative |
| `Frame Interpolate` | modelo `rife_v4.26` (ya en el workflow) |

### Validación manual (A4)
CLI `scripts/run_video.py --image <filename|URL> --model wan21|wan22 [--frames 81] [--steps 4] [--seed -1] [--prompt "..."]`.
Pasos: vídeo corto wan21 y wan22 (81 frames), con frames 100 (verificar snap →
101) y steps impar en wan22 (verificar → par). Esperado: `.mp4` con URL de salida.

---

## A5. Chaining + configuración global (backend)

### Objetivo
Exponer lo que el frontend necesita para 🔗/📋 y 🎨 sin lógica de UI.

### Contenido
- `result_url(filename, type="output")` → `{media_base}/view?filename=...&type=output`
  (usado por los 4 tools; la ref usa `/api/view`, se usa `/view` salvo que la
  validación diga lo contrario).
- `normalize_source(image)` → `(filename | url, kind)` — la auto-detección
  filename-vs-URL centralizada (Edit/Upscale/Video la comparten).
- `Settings` runtime: `set_base_url / set_media_base_url / set_api_key` para el
  🎨; persistencia en archivo de config del usuario (`.gradio-comfy-tools.json`)
  o env, según decisión al implementar.
- `last_generated` por sesión: lo gestiona el frontend (estado Gradio); el
  backend solo expone `result_url` y la convención de nombres.

### Validación manual (A5)
Script `scripts/run_chain.py`: genera → edita el resultado (filename) → upscales
ese resultado → vídeo desde ese resultado. Esperado: toda la cadena funciona
pasando **filenames** (no URLs) entre pasos.

---

## A6. Criterios de aceptación (backend completo)

1. `python3 scripts/check_env.py` → TODO OK (nodos + modelos contra el servidor).
2. `pytest` verde (tests con MockTransport para `comfy_client` y helpers).
3. Smoke + CLI de las 4 pestañas validados manualmente (A1–A4).
4. Cadena completa A5 validada.
5. Toda la funcionalidad de BACKEND.md §5–§6 implementada y verificada.

---

# Parte B — Frontend (pendiente)

> Se escribirá tras validar la Parte A. Estructura prevista:

- B0. `app.py` Gradio `gr.Blocks` + `queue()` — layout por pestañas según
  FRONTEND.md, conectando componentes a los tools de la Parte A.
- B1. Generate en la UI (primer cableado real end-to-end).
- B2. Edit / Upscale / Video en la UI (compare slider, player mock, URL field,
  🔗/📁).
- B3. Resultados: resultado + 📋 copiar, chaining 🔗, clear al cambiar de tab.
- B4. 🎨 settings + modal avanzado (LoRA config JSON) + toasts + responsive.

Cada fase incluirá su **Validación manual** en la UI (el usuario prueba la
pestaña en el navegador contra el backend real).
