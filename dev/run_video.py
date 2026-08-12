#!/usr/bin/env python3
"""A4 — run the Video tool from the CLI (manual validation).

Usage:
    python3 dev/run_video.py --image <filename|URL> --model wan21|wan22 \
        --prompt \"...\" [--frames 81] [--steps 4] [--seed -1] [--negative \"...\"] [--loras '[...]'] [--base URL]

Examples:
    python3 dev/run_video.py --image ComfyUI_temp_20260806T230005_b9f8d29f4a4d.png \
        --model wan21 --prompt \"the apple slowly rotates on the table, soft studio light\"
    python3 dev/run_video.py --image <file> --model wan22 --prompt \"...\" --frames 100 --steps 5
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import Settings  # noqa: E402
from tools.video import MODEL_VERSIONS, generate_video  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Run the Video tool (A4 validation)")
    p.add_argument("--image", required=True, help="filename or external URL")
    p.add_argument("--model", default="wan21", choices=MODEL_VERSIONS)
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative", default="")
    p.add_argument("--frames", type=int, default=81)
    p.add_argument("--steps", type=int, default=0, help="0 = model default (4)")
    p.add_argument("--seed", type=int, default=-1)
    p.add_argument("--loras", default="[]")
    p.add_argument("--base", default=None)
    args = p.parse_args()

    settings = Settings()
    if args.base:
        settings.comfyui_base_url = args.base.rstrip("/")

    print(f"Video: model={args.model} frames={args.frames} steps={args.steps} "
          f"seed={args.seed} loras={args.loras}")
    print(f"  image: {args.image}")
    print(f"  prompt: {args.prompt}")
    if args.negative:
        print(f"  negative: {args.negative}")

    try:
        url = generate_video(
            settings,
            image=args.image,
            model_version=args.model,
            prompt=args.prompt,
            negative_prompt=args.negative,
            frames=args.frames,
            steps=args.steps,
            seed=args.seed,
            lora_config=args.loras,
        )
    except Exception as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1

    print(f"\nResult URL: {url}")
    print("Open it in the browser to validate (MP4).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
