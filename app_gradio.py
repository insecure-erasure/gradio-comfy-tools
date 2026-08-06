"""Gradio UI experiment (branch feat/gradio-ui) — Generate tab, mockup-faithful.

Goal: reproduce the mockup's Generate layout as closely as Gradio 6 allows:
dark theme with the mockup palette, tabs bar (manual), split output/params
60/40, bottom prompt bar, steppers with ±, model-row with ⚙️/↺.

The backend (tools.generate) is the same validated one from master.
"""

from __future__ import annotations

import gradio as gr

from config import Settings
from tools.generate import FAMILY_OPTIONS, MODEL_CONFIGS, normalize_aspect_ratio, generate_image

# --------------------------------------------------------------------------- #
# Theme — mockup :root palette
# --------------------------------------------------------------------------- #
def make_theme() -> gr.Theme:
    return gr.themes.Base(
        primary_hue=gr.themes.Color(
            c50="#ffe9ee", c100="#ffc2cd", c200="#ff9aac", c300="#ff738c",
            c400="#ff4d6d", c500="#e94560", c600="#c93a52", c700="#a92f44",
            c800="#892436", c900="#691928", c950="#4d1018",
        ),
        secondary_hue=gr.themes.Color(
            c50="#eef0f7", c100="#d5d9ea", c200="#bcc3dd", c300="#a3accf",
            c400="#8a96c2", c500="#2a2a4a", c600="#24243f", c700="#1e1e34",
            c800="#181829", c900="#12121e", c950="#0c0c14",
        ),
        neutral_hue=gr.themes.Color(
            c50="#f5f5fa", c100="#eaeaea", c200="#d0d0dc", c300="#a0a0b0",
            c400="#7a7a8a", c500="#5a5a6a", c600="#3a3a4a", c700="#2a2a3a",
            c800="#1c1c2e", c900="#16213e", c950="#0d1526",
        ),
        text_size=gr.themes.Size(xxs="10px", xs="11px", sm="12px", md="14px", lg="16px", xl="18px", xxl="20px"),
        spacing_size=gr.themes.Size(xxs="2px", xs="4px", sm="8px", md="12px", lg="16px", xl="24px", xxl="32px"),
        radius_size=gr.themes.Size(xxs="2px", xs="4px", sm="6px", md="8px", lg="12px", xl="16px", xxl="20px"),
    )


# --------------------------------------------------------------------------- #
# Custom CSS — fight Gradio's shell toward the mockup
# --------------------------------------------------------------------------- #
CSS = """
/* full-height, no page scroll */
.gradio-container { max-width: 100% !important; height: 100dvh; background: #1a1a2e !important; color: #eaeaea !important; }
#gradio-app-shell { height: 100dvh !important; }
footer { display: none !important; }

/* tab bar */
#tabbar { background: #16213e !important; border-bottom: 1px solid #2a2a4a !important; margin: 0 !important; padding: 0 8px !important; min-height: 44px; align-items: center; }
#tabbar .tab-btn { background: transparent !important; color: #a0a0b0 !important; border: none !important; border-radius: 0 !important; box-shadow: none !important; padding: 12px 16px !important; font-size: .82rem !important; min-width: 0 !important; }
#tabbar .tab-btn.active { color: #eaeaea !important; border-bottom: 2px solid #e94560 !important; }

/* main split */
#split { margin: 0 !important; gap: 0 !important; flex: 1; min-height: 0; }
#output-pane { background: #111122 !important; border: none !important; padding: 24px !important; display: flex !important; align-items: center !important; justify-content: center !important; }
#output-pane img, #output-pane video { max-width: 100% !important; max-height: 100% !important; object-fit: contain !important; }
#params-pane { background: #1a1a2e !important; border-left: 1px solid #2a2a4a !important; padding: 16px !important; }

/* model-row */
.model-row { display: flex !important; align-items: center !important; gap: 8px !important; margin-bottom: 10px !important; }
.model-row > div { min-width: 0 !important; }
.model-row label { font-size: .78rem !important; color: #a0a0b0 !important; }
.btn-icon { background: #16213e !important; color: #a0a0b0 !important; border: 1px solid #2a2a4a !important; border-radius: 8px !important; width: 30px !important; min-width: 30px !important; max-width: 30px !important; flex: 0 0 30px !important; height: 30px !important; padding: 0 !important; font-size: .9rem !important; box-shadow: none !important; }

/* field rows + steppers */
.field-row { gap: 8px !important; margin-bottom: 10px !important; align-items: center !important; }
.field-inline { gap: 6px !important; align-items: center !important; }
.field-inline label { font-size: .78rem !important; color: #a0a0b0 !important; }
.readonly-field { font-size: .82rem !important; color: #eaeaea !important; }
.stepper { display: flex !important; flex-direction: row !important; align-items: center !important; gap: 0 !important; border: 1px solid #2a2a4a !important; border-radius: 8px !important; overflow: hidden !important; background: #16213e !important; width: auto !important; max-width: none !important; }
.stepper > .block, .stepper .wrap { flex: 0 0 auto !important; max-width: none !important; min-width: 0 !important; padding: 0 !important; margin: 0 !important; background: transparent !important; }
.stepper .wrap { display: flex !important; align-items: center !important; }
.stepper button { background: transparent !important; border: none !important; color: #a0a0b0 !important; width: 26px !important; height: 30px !important; min-width: 26px !important; padding: 0 !important; cursor: pointer !important; font-size: .9rem !important; box-shadow: none !important; flex: 0 0 auto !important; border-radius: 0 !important; margin: 0 !important; }
.stepper button:hover { background: #1c2a4a !important; color: #eaeaea !important; }
.stepper button:first-child { border-right: 1px solid #2a2a4a !important; }
.stepper button:last-child { border-left: 1px solid #2a2a4a !important; }
.stepper input { background: transparent !important; border: none !important; color: #eaeaea !important; text-align: center !important; width: 52px !important; min-width: 52px !important; font-size: .8rem !important; box-shadow: none !important; padding: 0 !important; height: 30px !important; }
.stepper input:focus { box-shadow: none !important; border: none !important; }
.stepper label { display: none !important; }

/* bottom bar */
#bottom-bar { background: #16213e !important; border-top: 1px solid #2a2a4a !important; margin: 0 !important; padding: 8px !important; align-items: stretch !important; }
#prompt-col { display: flex !important; flex-direction: column !important; gap: 4px !important; }
#prompt-col textarea { background: #1a1a2e !important; color: #eaeaea !important; border: 1px solid #2a2a4a !important; border-radius: 8px !important; }
#result-url-row { display: flex !important; align-items: center !important; gap: 8px !important; font-size: .72rem !important; color: #a0a0b0 !important; min-height: 18px !important; }
#result-url-row > * { flex: 0 0 auto !important; }
#result-url { flex: 1 !important; min-width: 0 !important; }
#btn-copy { width: 30px !important; min-width: 30px !important; max-width: 30px !important; flex: 0 0 30px !important; height: 26px !important; padding: 0 !important; }
#btn-col { display: flex !important; align-items: stretch !important; width: 44px !important; }
#btn-col > * { flex: 1 !important; }
.btn-generate { background: #e94560 !important; color: #fff !important; border: none !important; border-radius: 8px !important; width: 44px !important; min-width: 44px !important; max-width: 44px !important; flex: 1 !important; padding: 0 !important; font-size: 1.2rem !important; box-shadow: none !important; height: auto !important; }
.btn-generate:hover { background: #ff6b81 !important; }

/* hide the default Gradio number input spinners */
input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
input[type="number"] { -moz-appearance: textfield; }

/* hide default labels where we want inline letters */
.inline-label label { display: none !important; }
.tight-markdown { font-size: .82rem !important; color: #eaeaea !important; }

/* spinner is handled by Gradio's progress; we also add a CSS pulse */
"""


def build_app() -> gr.Blocks:
    settings = Settings()

    with gr.Blocks(
        title="Comfy Tools",
        fill_height=True,
    ) as app:
        current_tab = gr.State("generate")
        last_generated = gr.State(None)

        # ── Tab bar ─────────────────────────────────────────────
        with gr.Row(elem_id="tabbar"):
            with gr.Column(scale=6, elem_id="tabbar-output", min_width=0):
                with gr.Row(elem_id="tabbar-inner"):
                    tab_gen = gr.Button("🖼️ Generate", elem_classes=["tab-btn", "active"], elem_id="tab-gen")
                    tab_edit = gr.Button("✏️ Edit", elem_classes=["tab-btn"], elem_id="tab-edit-btn")
                    tab_ups = gr.Button("🔍 Upscale", elem_classes=["tab-btn"], elem_id="tab-ups")
                    tab_vid = gr.Button("🎬 Video", elem_classes=["tab-btn"], elem_id="tab-vid")
            with gr.Column(scale=4, elem_id="tabbar-params", min_width=280):
                btn_settings = gr.Button("🎨 Comfy Tools ▾", elem_id="settings-btn")

        # ── Split: output | params ───────────────────────────────
        with gr.Row(elem_id="split", scale=1):
            with gr.Column(scale=6, elem_id="output-pane", min_width=0):
                gen_output = gr.Image(interactive=False, show_label=False, container=False, elem_id="gen-output")
            with gr.Column(scale=4, elem_id="params-pane", min_width=280):
                # model-row
                with gr.Row(elem_classes=["model-row"], elem_id="model-row"):
                    gen_family = gr.Dropdown(
                        choices=FAMILY_OPTIONS, value="zimage", label="Model",
                        container=False, elem_classes=["model-dropdown"],
                    )
                    gen_gear = gr.Button("⚙️", elem_classes=["btn-icon"], elem_id="gen-gear")
                    gen_reset = gr.Button("↺", elem_classes=["btn-icon"], elem_id="gen-reset")
                # Row 1: W | H | AR | MP
                with gr.Row(elem_classes=["field-row"]):
                    gen_w = gr.Markdown("**W** 816", elem_classes=["tight-markdown"], elem_id="gen-w")
                    gen_h = gr.Markdown("**H** 1216", elem_classes=["tight-markdown"], elem_id="gen-h")
                    gen_ar = gr.Dropdown(
                        choices=["2:3", "1:1", "3:2", "3:4", "4:3", "9:16", "16:9"],
                        value="2:3", label="AR", container=False, elem_classes=["inline-label"],
                    )
                    with gr.Row(elem_classes=["stepper"], elem_id="mp-stepper"):
                        gen_mp_dec = gr.Button("−", elem_classes=["stepper-btn"])
                        gen_mp = gr.Number(value=1.0, minimum=0.1, maximum=2.0, step=0.1, show_label=False, container=False)
                        gen_mp_inc = gr.Button("+", elem_classes=["stepper-btn"])
                # Row 2: Steps | Seed + 🎲
                with gr.Row(elem_classes=["field-row"]):
                    with gr.Row(elem_classes=["stepper"], elem_id="steps-stepper"):
                        gen_steps_dec = gr.Button("−", elem_classes=["stepper-btn"])
                        gen_steps = gr.Number(value=10, minimum=1, maximum=15, step=1, show_label=False, container=False)
                        gen_steps_inc = gr.Button("+", elem_classes=["stepper-btn"])
                    with gr.Row(elem_classes=["stepper"], elem_id="seed-stepper"):
                        gen_seed_dec = gr.Button("−", elem_classes=["stepper-btn"])
                        gen_seed = gr.Number(value=-1, minimum=-1, step=1, show_label=False, container=False)
                        gen_seed_inc = gr.Button("+", elem_classes=["stepper-btn"])
                    gen_random = gr.Checkbox(value=True, label="🎲", elem_id="gen-random", elem_classes=["inline-label"])
                gen_lora = gr.Textbox(value="[]", label="LoRA config (JSON)", visible=False)

        # ── Bottom bar ───────────────────────────────────────────
        with gr.Row(elem_id="bottom-bar"):
            with gr.Column(scale=1, elem_id="prompt-col"):
                prompt = gr.Textbox(
                    placeholder="Describe the image you want to generate in detail...",
                    lines=2, show_label=False, container=False,
                )
                with gr.Row(elem_id="result-url-row"):
                    result_url = gr.Markdown("", elem_id="result-url", elem_classes=["tight-markdown"])
                    copy_btn = gr.Button("📋", elem_id="btn-copy", elem_classes=["btn-icon"])
            with gr.Column(elem_id="btn-col", min_width=44):
                gen_submit = gr.Button("✨", elem_classes=["btn-generate"], elem_id="btn-generate", min_width=44)

        # ══════════════ Events ══════════════

        def update_resolution(family, ar, mp):
            w, h = compute_resolution(family, ar, mp)
            return f"**W** {w}", f"**H** {h}"

        for comp in [gen_family, gen_ar, gen_mp]:
            comp.change(update_resolution, inputs=[gen_family, gen_ar, gen_mp], outputs=[gen_w, gen_h])

        def update_steps(family):
            return int(MODEL_CONFIGS[family]["steps"])

        gen_family.change(update_steps, inputs=gen_family, outputs=gen_steps)

        def toggle_seed(checked, seed):
            return -1 if checked else (seed if seed is not None else -1)

        gen_random.change(toggle_seed, inputs=[gen_random, gen_seed], outputs=gen_seed)

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
                raise gr.Error(err)
            gr.Info("✨ Workflow submitted to ComfyUI")
            return _bytes_to_pil(_fetch_image_bytes(url)), f"`{url}`", url

        gen_submit.click(
            submit_generate,
            inputs=[gen_family, prompt, gen_ar, gen_mp, gen_steps, gen_seed, gen_lora, last_generated],
            outputs=[gen_output, result_url, last_generated],
        )

        # Reset
        def reset_gen():
            return "zimage", "2:3", 1.0, 10, -1, True

        gen_reset.click(reset_gen, outputs=[gen_family, gen_ar, gen_mp, gen_steps, gen_seed, gen_random])

        # Gear / settings (WIP)
        gen_gear.click(lambda: gr.Info("Advanced (WIP)"), inputs=[], outputs=[])
        btn_settings.click(lambda: gr.Info("Settings (WIP)"), inputs=[], outputs=[])

        # Copy
        copy_btn.click(lambda: gr.Info("URL copied"), inputs=[], outputs=[])

        # Tabs (only Generate wired; others show a placeholder in output)
        def switch_tab(target):
            # For now, only Generate is implemented; others show a message
            return target

        for b, name in [(tab_gen, "generate"), (tab_edit, "edit"), (tab_ups, "upscale"), (tab_vid, "video")]:
            b.click(
                lambda n=name: (f"**{n} tab — WIP in this Gradio experiment**", n),
                outputs=[result_url, current_tab],
            )

    return app


# --------------------------------------------------------------------------- #
# Helpers (same as server/app.html path)
# --------------------------------------------------------------------------- #
def compute_resolution(family: str, aspect_ratio: str, megapixel: float) -> tuple[int, int]:
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
    app.queue().launch(server_name="0.0.0.0", server_port=7860, css=CSS, theme=make_theme())
