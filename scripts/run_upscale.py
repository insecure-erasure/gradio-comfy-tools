#!/usr/bin/env python3
"""A3 — run the Upscale tool from the CLI (manual validation).

Usage:
    python3 scripts/run_upscale.py --image <filename|URL> [--seed -1] [--base URL]

Examples:
    python3 scripts/run_upscale.py --image ComfyUI_temp_20260806T230005_b9f8d29f4a4d.png --seed 3
    python3 scripts/run_upscale.py --image http://akari.home/view?filename=...png --seed -1
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import Settings  # noqa: E402
from tools.upscale import upscale_image  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Run the Upscale tool (A3 validation)")
    p.add_argument("--image", required=True, help="filename or external URL")
    p.add_argument("--seed", type=int, default=-1)
    p.add_argument("--base", default=None)
    args = p.parse_args()

    settings = Settings()
    if args.base:
        settings.comfyui_base_url = args.base.rstrip("/")

    print(f"Upscale: seed={args.seed}")
    print(f"  image: {args.image}")

    try:
        url = upscale_image(settings, image=args.image, seed=args.seed)
    except Exception as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1

    print(f"\nResult URL: {url}")
    print("Open it in the browser to validate (2x, 2048 on the long side).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
