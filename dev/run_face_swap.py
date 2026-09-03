#!/usr/bin/env python3
"""Run the Face swap tool from the CLI (manual validation).

Usage:
    python3 dev/run_face_swap.py --image <filename|URL> --face <filename|URL> \
        [--prompt "extra instructions"] [--steps 6] [--cfg 1] [--seed -1] [--base URL]

Examples:
    # swap the face from an uploaded temp file onto a base URL, appending an
    # extra instruction to the built-in head_swap prompt
    python3 dev/run_face_swap.py --image https://example.com/person.jpg \
        --face ComfyUI_temp_...png --prompt "add a subtle smile" --steps 8 --cfg 1
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import Settings  # noqa: E402
from tools.face_swap import face_swap_image  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Run the Face swap tool")
    p.add_argument("--image", required=True, help="base image (Picture 1): filename or external URL")
    p.add_argument("--face", required=True, help="face source (Picture 2): filename or external URL")
    p.add_argument("--prompt", default="", help="optional extra prompt, appended after the built-in head_swap instructions")
    p.add_argument("--steps", type=int, default=0, help="0 = workflow default (6)")
    p.add_argument("--cfg", type=float, default=0.0, help="0 = workflow default (1)")
    p.add_argument("--seed", type=int, default=-1)
    p.add_argument("--base", default=None)
    args = p.parse_args()

    settings = Settings()
    if args.base:
        settings.comfyui_base_url = args.base.rstrip("/")

    print(f"Face swap: steps={args.steps} cfg={args.cfg} seed={args.seed}")
    print(f"  image (base): {args.image}")
    print(f"  face (src):   {args.face}")
    if args.prompt:
        print(f"  prompt:       {args.prompt}")

    try:
        url = face_swap_image(
            settings,
            image=args.image,
            face=args.face,
            prompt=args.prompt,
            steps=args.steps,
            cfg=args.cfg,
            seed=args.seed,
        )
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(f"\nResult URL: {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
