"""Gradio frontend — Part B (B0 skeleton + B1 Generate tab).

Layout per FRONTEND.md: tabs bar, output pane (left) + params pane (right),
bottom prompt bar with the action button. Per-tab parameter state persists
across tab switches; the result URL row is cleared on switch; session-global
``last_generated`` persists for chaining (🔗 in B2).

B1: the Generate tab is fully wired to the backend (tools.generate).
Edit/Upscale/Video are stubs (WIP) that will be wired in B2.
"""

from __future__ import annotations

import gradio as gr

from config import Settings
from tools.generate import FAMILY_OPTIONS, MODEL_CONFIGS, normalize_aspect_ratio, generate_image

# --------------------------------------------------------------------------- #
# Resolution (mirrors the mockup §4.1)
# --------------------------------------------------------------------------- #
def compute_resolution(family: str, aspect_ratio: str, megapixel: float) -> tuple[int, int]:
    """W/H from MP × AR × vae_scale (live calculation, not hardcoded)."""
    vae_scale = MODEL_CONFIGS[family]["vae_scale_factor"]
    total_pixels = megapixel * 1_000_000
    w_ratio, h_ratio = normalize_aspect_ratio(aspect_ratio)
    raw_w = (total_pixels * w_ratio / h_ratio) ** 0.5
    raw_h = raw_w * h_ratio / w_ratio
    width = max(vae_scale, round(raw_w / vae_scale) * vae_scale)
    height = max(vae_scale, round(raw_h / vae_scale) * vae_scale)
    return width, height


# --------------------------------------------------------------------------- #
# Backend calls
# --------------------------------------------------------------------------- #
def _run_generate(family, prompt, aspect_ratio, megapixel, steps, seed, lora_config):
    """Submit to the backend; returns (result_url, last_generated_url, error)."""
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


def _fetch_image_bytes(url: str) -> bytes | None:
    """Download the image bytes from the ComfyUI server (avoids CORS/host
    validation when the browser displays an external-host image)."""
    import httpx

    try:
        with httpx.Client(timeout=30) as hc:
            resp = hc.get(url)
            resp.raise_for_status()
            return resp.content
    except Exception:
        return None


def _bytes_to_pil(data: bytes | None):
    """bytes -> PIL.Image for gr.Image (Gradio 6 accepts PIL, not bytes)."""
    if not data:
        return None
    import io

    from PIL import Image

    try:
        return Image.open(io.BytesIO(data))
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Build the app
# --------------------------------------------------------------------------- #
def build_app() -> gr.Blocks:
    settings = Settings()

    with gr.Blocks(title="Comfy Tools") as app:
        gr.Markdown("# 🎨 Comfy Tools")
        with gr.Row():
            gr.Markdown(f"ComfyUI: `{settings.comfyui_base_url}`")

        # --- session state (persists across tabs) ---
        last_generated = gr.State(None)

        # ── Tabs ────────────────────────────────────────────────
        with gr.Tabs():
            # ══════════════ TAB 1: Generate ══════════════
            with gr.Tab("🖼️ Generate") as tab_generate:
                with gr.Row():
                    # Output pane (left)
                    with gr.Column(scale=6):
                        gen_output = gr.Image(label="Result", interactive=False)
                        gen_result_url = gr.Textbox(label="Result URL", interactive=False, visible=False)
                        with gr.Row():
                            gen_copy = gr.Button("📋 Copy URL", size="sm")
                    # Params pane (right)
                    with gr.Column(scale=4):
                        with gr.Row():
                            gr.Markdown("**Model**")
                            gen_family = gr.Dropdown(
                                choices=FAMILY_OPTIONS, value="zimage", label="Family",
                                info="Z-Image Turbo / Krea 2 / FLUX.2 Klein",
                            )
                            gen_reset = gr.Button("↺", size="sm")
                            gen_modal_btn = gr.Button("⚙️", size="sm")
                        with gr.Row():
                            gen_w = gr.Textbox(label="W", value="816", interactive=False)
                            gen_h = gr.Textbox(label="H", value="1216", interactive=False)
                            gen_ar = gr.Dropdown(
                                choices=["2:3", "1:1", "3:2", "3:4", "4:3", "9:16", "16:9"],
                                value="2:3", label="AR",
                            )
                            gen_mp = gr.Number(label="📐 MP", value=1.0, minimum=0.1, maximum=2.0, step=0.1)
                        with gr.Row():
                            gen_steps = gr.Number(label="👣 Steps", value=10, minimum=1, maximum=15, step=1)
                            gen_seed = gr.Number(label="🌱 Seed", value=-1, minimum=-1, step=1)
                            gen_random = gr.Checkbox(label="🎲", value=True, info="random seed")
                        # LoRA config (hidden; edited via ⚙️ modal)
                        gen_lora_config = gr.Textbox(label="LoRA config (JSON)", value="[]", visible=False)
                # Bottom prompt bar
                with gr.Row():
                    gen_prompt = gr.Textbox(
                        label="Prompt",
                        placeholder="Describe the image you want to generate in detail...",
                        lines=2,
                    )
                    gen_submit = gr.Button("✨ Generate", variant="primary", scale=0)

            # ══════════════ TAB 2: Edit (WIP) ══════════════
            with gr.Tab("✏️ Edit") as tab_edit:
                gr.Markdown("**Edit — WIP (B2)**")
                gr.Markdown("Source image URL field + 🔗 chaining will be wired here.")

            # ══════════════ TAB 3: Upscale (WIP) ══════════════
            with gr.Tab("🔍 Upscale") as tab_upscale:
                gr.Markdown("**Upscale — WIP (B2)**")

            # ══════════════ TAB 4: Video (WIP) ══════════════
            with gr.Tab("🎬 Video") as tab_video:
                gr.Markdown("**Video — WIP (B2)**")

        # ══════════════ Events ══════════════

        # Resolution recalculated live on any change
        def update_resolution(family, ar, mp):
            w, h = compute_resolution(family, ar, mp)
            return w, h

        for comp in [gen_family, gen_ar, gen_mp]:
            comp.change(
                update_resolution,
                inputs=[gen_family, gen_ar, gen_mp],
                outputs=[gen_w, gen_h],
            )

        # Model change -> auto-set steps
        def update_steps(family):
            return int(MODEL_CONFIGS[family]["steps"])

        gen_family.change(update_steps, inputs=gen_family, outputs=gen_steps)

        # 🎲 random -> toggle seed
        def toggle_seed(random_checked, seed):
            return -1 if random_checked else (seed if seed is not None else -1)

        gen_random.change(toggle_seed, inputs=[gen_random, gen_seed], outputs=gen_seed)

        # Submit
        def submit_generate(family, prompt, ar, mp, steps, seed, lora_config, last):
            url, new_last, err = _run_generate(
                family, prompt, ar, mp, steps, seed, lora_config
            )
            if err:
                gr.Info(f"❌ {err}")
                return None, "", None, last
            gr.Info("✨ Generated")
            # fetch bytes so the browser does not hit CORS/host validation
            image_pil = _bytes_to_pil(_fetch_image_bytes(url))
            return image_pil, url, url, url  # (image, result_url, visible_url, last_generated)

        gen_submit.click(
            submit_generate,
            inputs=[gen_family, gen_prompt, gen_ar, gen_mp, gen_steps, gen_seed, gen_lora_config, last_generated],
            outputs=[gen_output, gen_result_url, gen_result_url, last_generated],
        )

        # Copy
        gen_copy.click(
            lambda url: gr.Info(f"Copied: {url}"),
            inputs=gen_result_url,
            outputs=[],
        )

        # Reset
        def reset_generate():
            return "zimage", "2:3", 1.0, 10, -1, True

        gen_reset.click(
            reset_generate,
            outputs=[gen_family, gen_ar, gen_mp, gen_steps, gen_seed, gen_random],
        )

        # ⚙️ modal — keep a minimal advanced LoRA config inline for now (B4 refines)
        # (Gradio 6 has no gr.Modal; a simple visible textbox toggled is used)

        # On tab switch: clear the result URL row (per mockup), keep params
        def clear_result():
            return "", None

        for t in [tab_generate, tab_edit, tab_upscale, tab_video]:
            t.select(clear_result, outputs=[gen_result_url, gen_output])

    return app


if __name__ == "__main__":
    app = build_app()
    css = """
    footer {display:none !important;}
    .app-shell {gap: 12px;}
    """
    app.queue().launch(server_name="0.0.0.0", server_port=7860, css=css)
