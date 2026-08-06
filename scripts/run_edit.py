#!/usr/bin/env python3
"""A2 — run the Edit tool from the CLI (manual validation).

Usage:
    python3 scripts/run_edit.py --image <filename|URL> --mode edit|restore \
        [--prompt \"...\"] [--steps 6] [--seed -1] [--loras '[...]'] [--base URL]

Examples:
    # edit an uploaded temp file (from a previous generation)
    python3 scripts/run_edit.py --image ComfyUI_temp_20260806T230005_b9f8d29f4a4d.png \
        --mode edit --prompt \"make the apple green\" --seed 5
    # edit from an external URL
    python3 scripts/run_edit.py --image https://example.com/img.png --mode edit --prompt \"...\"
    # restore mode
    python3 scripts/run_edit.py --image <file> --mode restore
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import Settings  # noqa: E402
from tools.edit import MODES, edit_image  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Run the Edit tool (A2 validation)")
    p.add_argument("--image", required=True, help="filename or external URL")
    p.add_argument("--mode", default="edit", choices=MODES)
    p.add_argument("--prompt", default="")
    p.add_argument("--steps", type=int, default=0, help="0 = workflow default (6)")
    p.add_argument("--seed", type=int, default=-1)
    p.add_argument("--loras", default="[]")
    p.add_argument("--base", default=None)
    args = p.parse_args()

    settings = Settings()
    if args.base:
        settings.comfyui_base_url = args.base.rstrip("/")

    print(f"Edit: mode={args.mode} steps={args.steps} seed={args.seed} loras={args.loras}")
    print(f"  image: {args.image}")
    if args.prompt:
        print(f"  prompt: {args.prompt}")

    try:
        url = edit_image(
            settings,
            image=args.image,
            mode=args.mode,
            prompt=args.prompt,
            steps=args.steps,
            seed=args.seed,
            lora_config=args.loras,
        )
    except Exception as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1

    print(f"\nResult URL: {url}")
    print("Open it in the browser to validate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
