"""Gradio frontend — Part B. Faithful port of mockup.html.

Reproduces the mockup layout exactly: tabs bar (4 tabs + 🎨 Comfy Tools),
split output/params panes (60/40), bottom prompt bar with result URL + 📋 +
action button, steppers with ±, model-row with ⚙️/↺, dark theme
(--bg #1a1a2e, --surface #16213e, --accent #e94560, --text #eaeaea).

Tabs are manual (gr.State + visible toggles), not gr.Tabs, to mirror the
mockup's DOM and keep every tab's parameter state mounted (persists on
switch). B1: Generate fully wired; Edit/Upscale/Video params + output are
the mockup's controls with WIP toasts until B2 wires the backend.
"""

from __future__ import annotations

import gradio as gr

from config import Settings
from tools.generate import FAMILY_OPTIONS, MODEL_CONFIGS, normalize_aspect_ratio, generate_image

# --------------------------------------------------------------------------- #
# Theme (mockup :root vars)
# --------------------------------------------------------------------------- #
CSS = """
:root {
  --bg: #1a1a2e; --surface: #16213e; --surface-hover: #1c2a4a;
  --accent: #e94560; --accent-hover: #ff6b81;
  --text: #eaeaea; --text-secondary: #a0a0b0; --border: #2a2a4a; --radius: 8px;
  --font: 'Segoe UI', system-ui, -apple-system, sans-serif;
}
.gradio-container { background: var(--bg) !important; color: var(--text); font-family: var(--font); max-width: 100% !important; }
footer { display: none !important; }
#app { gap: 0 !important; }

/* ── Tab bar ── */
#tabbar { background: var(--surface); border-bottom: 1px solid var(--border); margin: 0 !important; padding: 0 !important; min-height: 44px; align-items: center; }
#tabbar-output { display: flex; align-items: center; padding-left: 12px; }
#tabbar-params { display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; border-left: 1px solid var(--border); }
.tab-btn { background: transparent !important; color: var(--text-secondary) !important; border: none !important; border-radius: 0 !important; box-shadow: none !important; padding: 12px 16px !important; font-size: .82rem !important; }
.tab-btn.active { color: var(--text) !important; border-bottom: 2px solid var(--accent) !important; }
#settings-btn { background: transparent !important; color: var(--text) !important; border: none !important; box-shadow: none !important; font-size: .82rem !important; }

/* ── Split ── */
#split { margin: 0 !important; gap: 0 !important; }
#output-pane { background: #111122; display: flex; align-items: center; justify-content: center; padding: 24px; min-height: 0; overflow: auto; }
#output-pane .output-placeholder { color: var(--text-secondary); text-align: center; }
#params-pane { background: var(--bg); padding: 16px; border-left: 1px solid var(--border); overflow-y: auto; max-width: 480px; min-width: 280px; }

/* ── model-row ── */
.model-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.model-row label { font-size: .78rem; color: var(--text-secondary); }
.model-row select, .model-row input { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; font-size: .8rem; }
.btn-icon { background: var(--surface) !important; color: var(--text-secondary) !important; border: 1px solid var(--border) !important; border-radius: var(--radius) !important; min-width: 30px !important; height: 30px !important; padding: 0 !important; font-size: .9rem !important; box-shadow: none !important; }

/* ── field rows ── */
.field-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
.field-inline { display: flex; align-items: center; gap: 6px; }
.field-inline label { font-size: .78rem; color: var(--text-secondary); }
.readonly-field { font-size: .82rem; color: var(--text); }

/* ── stepper ── */
.stepper { display: flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
.stepper button { background: transparent; border: none; color: var(--text-secondary); width: 26px; height: 30px; cursor: pointer; font-size: .9rem; }
.stepper button:hover { background: var(--surface-hover); color: var(--text); }
.stepper button:first-child { border-right: 1px solid var(--border); }
.stepper button:last-child { border-left: 1px solid var(--border); }
.stepper input { background: transparent; border: none; color: var(--text); text-align: center; width: 52px; font-size: .8rem; }
.stepper input:disabled { opacity: .4; }
.check-label { display: inline-flex; align-items: center; }

/* ── bottom bar ── */
#bottom-bar { background: var(--surface); border-top: 1px solid var(--border); margin: 0 !important; padding: 8px !important; align-items: stretch; }
#prompt-col { display: flex; flex-direction: column; gap: 4px; }
#prompt-col textarea { background: var(--bg) !important; color: var(--text) !important; border: 1px solid var(--border) !important; border-radius: var(--radius) !important; }
.result-url-row { display: flex; align-items: center; gap: 8px; font-size: .72rem; color: var(--text-secondary); min-height: 18px; }
.result-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-copy-inline { background: var(--surface) !important; border: 1px solid var(--border) !important; border-radius: var(--radius) !important; color: var(--text-secondary) !important; min-width: 30px !important; height: 26px !important; padding: 0 !important; }
#btn-col { display: flex; align-items: stretch; }
.btn-generate { background: var(--accent) !important; color: #fff !important; border: none !important; border-radius: var(--radius) !important; min-width: 44px !important; padding: 0 16px !important; font-size: 1rem !important; box-shadow: none !important; }
.btn-generate:hover { background: var(--accent-hover) !important; }

/* ocultar labels por defecto de gradio para W/H/AR/MP inline */
.tight-label label { display: none !important; }
"""


def build_app() -> gr.Blocks:
    settings = Settings()

    with gr.Blocks(title="Comfy Tools") as app:
        gr.HTML("")  # anchor for #app css? not needed
        current_tab = gr.State("generate")
        last_generated = gr.State(None)

        # ── Tab bar ─────────────────────────────────────────────
        with gr.Row(elem_id="tabbar"):
            with gr.Column(scale=6, elem_id="tabbar-output"):
                with gr.Row():
                    tab_gen = gr.Button("🖼️ Generate", elem_classes=["tab-btn", "active"], elem_id="tab-btn-gen")
                    tab_edit = gr.Button("✏️ Edit", elem_classes=["tab-btn"], elem_id="tab-btn-edit")
                    tab_ups = gr.Button("🔍 Upscale", elem_classes=["tab-btn"], elem_id="tab-btn-ups")
                    tab_vid = gr.Button("🎬 Video", elem_classes=["tab-btn"], elem_id="tab-btn-vid")
            with gr.Column(scale=4, elem_id="tabbar-params"):
                btn_settings = gr.Button("🎨 Comfy Tools ▾", elem_id="settings-btn")

        # ── Split: output | params ───────────────────────────────
        with gr.Row(elem_id="split"):
            # OUTPUT pane (one per tab; only active visible)
            with gr.Column(scale=6, elem_id="output-pane"):
                with gr.Column(visible=True) as out_gen:
                    gen_image = gr.Image(interactive=False, show_label=False, elem_id="gen-image")
                with gr.Column(visible=False) as out_edit:
                    gr.HTML('<div class="output-placeholder">✏️ Edit — compare slider (B2)<br>will appear here</div>')
                with gr.Column(visible=False) as out_ups:
                    gr.HTML('<div class="output-placeholder">🔍 Upscale — compare slider (B2)<br>will appear here</div>')
                with gr.Column(visible=False) as out_vid:
                    gr.HTML('<div class="output-placeholder">🎬 Video — player (B2)<br>will appear here</div>')

            # PARAMS pane (per-tab params; only active visible)
            with gr.Column(scale=4, elem_id="params-pane"):
                # ── Generate ──
                with gr.Column(visible=True) as params_gen:
                    with gr.Row(elem_classes=["model-row"]):
                        gen_family = gr.Dropdown(
                            choices=FAMILY_OPTIONS, value="zimage", label="Model",
                            elem_classes=["model-dropdown"],
                        )
                        gen_modal = gr.Button("⚙️", elem_classes=["btn-icon"], elem_id="gen-gear")
                        gen_reset = gr.Button("↺", elem_classes=["btn-icon"], elem_id="gen-reset")
                    with gr.Row(elem_classes=["field-row"]):
                        gen_w = gr.Markdown("**W** 816", elem_classes=["field-inline", "tight-label"])
                        gen_h = gr.Markdown("**H** 1216", elem_classes=["field-inline", "tight-label"])
                        gen_ar = gr.Dropdown(
                            choices=["2:3", "1:1", "3:2", "3:4", "4:3", "9:16", "16:9"],
                            value="2:3", label="AR", elem_classes=["field-inline", "tight-label"],
                        )
                        with gr.Row(elem_classes=["field-inline", "tight-label"]):
                            gr.Markdown("**📐**")
                            gen_mp_dec = gr.Button("−", elem_classes=["stepper-btn"])
                            gen_mp = gr.Number(value=1.0, minimum=0.1, maximum=2.0, step=0.1, show_label=False)
                            gen_mp_inc = gr.Button("+", elem_classes=["stepper-btn"])
                    with gr.Row(elem_classes=["field-row"]):
                        with gr.Row(elem_classes=["field-inline", "tight-label"]):
                            gr.Markdown("**👣**")
                            gen_steps_dec = gr.Button("−", elem_classes=["stepper-btn"])
                            gen_steps = gr.Number(value=10, minimum=1, maximum=15, step=1, show_label=False)
                            gen_steps_inc = gr.Button("+", elem_classes=["stepper-btn"])
                        with gr.Row(elem_classes=["field-inline", "tight-label"]):
                            gr.Markdown("**🌱**")
                            gen_seed_dec = gr.Button("−", elem_classes=["stepper-btn"])
                            gen_seed = gr.Number(value=-1, minimum=-1, step=1, show_label=False)
                            gen_seed_inc = gr.Button("+", elem_classes=["stepper-btn"])
                            gen_random = gr.Checkbox(value=True, label="🎲", elem_classes=["check-label"])
                    gen_lora = gr.Textbox(value="[]", label="LoRA config (JSON)", visible=False)

                # ── Edit (WIP params per mockup) ──
                with gr.Column(visible=False) as params_edit:
                    gr.HTML('<div class="output-placeholder">Edit params — B2</div>')
                # ── Upscale (WIP) ──
                with gr.Column(visible=False) as params_ups:
                    gr.HTML('<div class="output-placeholder">Upscale params — B2</div>')
                # ── Video (WIP) ──
                with gr.Column(visible=False) as params_vid:
                    gr.HTML('<div class="output-placeholder">Video params — B2</div>')

        # ── Bottom bar ───────────────────────────────────────────
        with gr.Row(elem_id="bottom-bar"):
            with gr.Column(scale=1, elem_id="prompt-col"):
                prompt = gr.Textbox(
                    placeholder="Describe the image you want to generate in detail...",
                    lines=2, show_label=False,
                )
                with gr.Row(elem_id="result-url-row"):
                    result_url = gr.Markdown("", elem_classes=["result-url"])
                    copy_btn = gr.Button("📋", elem_classes=["btn-copy-inline"], elem_id="btn-copy")
            with gr.Column(elem_id="btn-col"):
                gen_submit = gr.Button("✨", elem_classes=["btn-generate"], elem_id="btn-generate")

        # ══════════════ Events ══════════════

        # Resolution recalculated live
        def update_resolution(family, ar, mp):
            w, h = compute_resolution(family, ar, mp)
            return f"**W** {w}", f"**H** {h}"

        for comp in [gen_family, gen_ar, gen_mp]:
            comp.change(update_resolution, inputs=[gen_family, gen_ar, gen_mp], outputs=[gen_w, gen_h])

        # Model -> auto steps
        def update_steps(family):
            return int(MODEL_CONFIGS[family]["steps"])

        gen_family.change(update_steps, inputs=gen_family, outputs=gen_steps)

        # 🎲 -> seed
        def toggle_seed(checked, seed):
            return -1 if checked else (seed if seed is not None else -1)

        gen_random.change(toggle_seed, inputs=[gen_random, gen_seed], outputs=gen_seed)

        # Steppers
        def step(v, d, lo, hi):
            v = lo if v is None else float(v)
            return max(lo, min(hi, v + d))

        gen_mp_dec.click(lambda v: step(v, -0.1, 0.1, 2.0), inputs=gen_mp, outputs=gen_mp)
        gen_mp_inc.click(lambda v: step(v, 0.1, 0.1, 2.0), inputs=gen_mp, outputs=gen_mp)
        gen_steps_dec.click(lambda v: step(v, -1, 1, 15), inputs=gen_steps, outputs=gen_steps)
        gen_steps_inc.click(lambda v: step(v, 1, 1, 15), inputs=gen_steps, outputs=gen_steps)
        gen_seed_dec.click(lambda v: step(v, -1, -1, 2**63), inputs=gen_seed, outputs=gen_seed)
        gen_seed_inc.click(lambda v: step(v, 1, -1, 2**63), inputs=gen_seed, outputs=gen_seed)

        # Submit
        def submit_generate(family, prompt, ar, mp, steps, seed, lora_config, last):
            url, new_last, err = _run_generate(family, prompt, ar, mp, steps, seed, lora_config)
            if err:
                gr.Info(f"❌ {err}")
                return None, f"**{err}**", last
            gr.Info("✨ Workflow submitted to ComfyUI")
            image_pil = _bytes_to_pil(_fetch_image_bytes(url))
            return image_pil, f"`{url}`", url

        gen_submit.click(
            submit_generate,
            inputs=[gen_family, prompt, gen_ar, gen_mp, gen_steps, gen_seed, gen_lora, last_generated],
            outputs=[gen_image, result_url, last_generated],
        )

        # Copy
        copy_btn.click(lambda: gr.Info("URL copied"), inputs=[], outputs=[])

        # Reset
        def reset_gen():
            return "zimage", "2:3", 1.0, 10, -1, True

        gen_reset.click(reset_gen, outputs=[gen_family, gen_ar, gen_mp, gen_steps, gen_seed, gen_random])

        # Gear (WIP -> advanced modal B4)
        gen_modal.click(lambda: gr.Info("Advanced modal (WIP — B4)"), inputs=[], outputs=[])
        btn_settings.click(lambda: gr.Info("Settings (WIP — B4)"), inputs=[], outputs=[])

        # Tab switching (mockup: params persist; result URL row cleared)
        def switch_tab(target):
            vis = {
                "generate": (True, False, False, False, True, False, False, False),
                "edit": (False, True, False, False, False, True, False, False),
                "upscale": (False, False, True, False, False, False, True, False),
                "video": (False, False, False, True, False, False, False, True),
            }
            outs, params, tab = vis[target][:4], vis[target][4:], target
            return list(outs) + list(params) + ["", tab]

        tab_gen.click(
            lambda: switch_tab("generate"),
            outputs=[out_gen, out_edit, out_ups, out_vid, params_gen, params_edit, params_ups, params_vid, result_url, current_tab],
        )
        tab_edit.click(
            lambda: switch_tab("edit"),
            outputs=[out_gen, out_edit, out_ups, out_vid, params_gen, params_edit, params_ups, params_vid, result_url, current_tab],
        )
        tab_ups.click(
            lambda: switch_tab("upscale"),
            outputs=[out_gen, out_edit, out_ups, out_vid, params_gen, params_edit, params_ups, params_vid, result_url, current_tab],
        )
        tab_vid.click(
            lambda: switch_tab("video"),
            outputs=[out_gen, out_edit, out_ups, out_vid, params_gen, params_edit, params_ups, params_vid, result_url, current_tab],
        )

        # Clear result URL when switching (per mockup)
        def clear_url():
            return ""

        # (handled inside switch_tab via the result_url output)

    return app


# --------------------------------------------------------------------------- #
# Helpers (outside build for testability)
# --------------------------------------------------------------------------- #
def compute_resolution(family: str, aspect_ratio: str, megapixel: float) -> tuple[int, int]:
    """W/H from MP × AR × vae_scale (mockup §4.1)."""
    vae_scale = MODEL_CONFIGS[family]["vae_scale_factor"]
    total_pixels = megapixel * 1_000_000
    w_ratio, h_ratio = normalize_aspect_ratio(aspect_ratio)
    raw_w = (total_pixels * w_ratio / h_ratio) ** 0.5
    raw_h = raw_w * h_ratio / w_ratio
    width = max(vae_scale, round(raw_w / vae_scale) * vae_scale)
    height = max(vae_scale, round(raw_h / vae_scale) * vae_scale)
    return width, height


def _run_generate(family, prompt, aspect_ratio, megapixel, steps, seed, lora_config):
    settings = Settings()
    try:
        url = generate_image(
            settings,
            family=family,
            prompt=prompt or "",
            aspect_ratio=aspect_ratio,
            megapixel=float(megapixel),
            steps=int(steps),
            seed=int(seed),
            lora_config=lora_config or "[]",
        )
        return url, url, None
    except Exception as e:
        return None, None, str(e)


def _fetch_image_bytes(url: str):
    import httpx

    try:
        with httpx.Client(timeout=30) as hc:
            resp = hc.get(url)
            resp.raise_for_status()
            return resp.content
    except Exception:
        return None


def _bytes_to_pil(data):
    if not data:
        return None
    import io

    from PIL import Image

    try:
        return Image.open(io.BytesIO(data))
    except Exception:
        return None


if __name__ == "__main__":
    app = build_app()
    app.queue().launch(server_name="0.0.0.0", server_port=7860, css=CSS, theme=gr.themes.Base())
