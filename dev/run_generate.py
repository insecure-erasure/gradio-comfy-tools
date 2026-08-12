#!/usr/bin/env python3
"""A1 — run the Generate tool from the CLI (manual validation).

Usage:
    python3 dev/run_generate.py --family zimage|krea2|flux2 --prompt \"...\" \
        [--ar 16:9] [--mp 1.0] [--steps 8] [--seed -1] [--loras '[...]'] [--base URL]

Examples:
    python3 dev/run_generate.py --family zimage --prompt \"a red apple on a table\"
    python3 dev/run_generate.py --family krea2 --prompt \"a cat\" --ar 16:9 --seed 42
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import Settings  # noqa: E402
from tools.generate import FAMILY_OPTIONS, generate_image  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Run the Generate tool (A1 validation)")
    p.add_argument("--family", default="zimage", choices=FAMILY_OPTIONS)
    p.add_argument("--prompt", required=True)
    p.add_argument("--ar", default="2:3", help="aspect ratio W:H")
    p.add_argument("--mp", type=float, default=1.0, help="megapixel 0.1-2.0")
    p.add_argument("--steps", type=int, default=0, help="0 = family default")
    p.add_argument("--seed", type=int, default=-1, help="-1 = random")
    p.add_argument("--loras", default="[]", help='JSON array, e.g. \'[{"name": "flux2/Flux2-Klein-Image-RestoreV1.safetensors", "strength": 1.0}]\'')
    p.add_argument("--base", default=None, help="ComfyUI base URL override")
    args = p.parse_args()

    settings = Settings()
    if args.base:
        settings.comfyui_base_url = args.base.rstrip("/")

    print(f"Generate: family={args.family} ar={args.ar} mp={args.mp} "
          f"steps={args.steps} seed={args.seed} loras={args.loras}")
    print(f"  prompt: {args.prompt}")

    try:
        url = generate_image(
            settings,
            family=args.family,
            prompt=args.prompt,
            aspect_ratio=args.ar,
            megapixel=args.mp,
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
