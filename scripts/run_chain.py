#!/usr/bin/env python3
"""A5 — full chain validation (manual): generate -> edit -> upscale -> video.

Passes **filenames** (not URLs) between steps — the same flow the frontend
will use for 🔗 chaining (last_generated -> source field).

Usage:
    python3 scripts/run_chain.py [--prompt \"...\"] [--seed 42] [--base URL]

Steps:
  1. generate_image   -> image A (zimage, 2:3, seed)
  2. edit_image       -> image B (edit A via its filename)
  3. upscale_image    -> image C (upscale B via its filename)
  4. generate_video   -> MP4  D (wan21 video from C via its filename)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import Settings  # noqa: E402
from tools.generate import generate_image  # noqa: E402
from tools.edit import edit_image  # noqa: E402
from tools.upscale import upscale_image  # noqa: E402
from tools.video import generate_video  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Full chain validation (A5)")
    p.add_argument("--prompt", default="a red apple on a wooden table, studio lighting")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--base", default=None)
    args = p.parse_args()

    settings = Settings()
    if args.base:
        settings.comfyui_base_url = args.base.rstrip("/")

    print(f"Chain seed={args.seed} prompt={args.prompt!r}")
    try:
        # 1. generate
        print("\n[1/4] generate ...")
        url_a = generate_image(settings, family="zimage", prompt=args.prompt, seed=args.seed)
        print(f"      A: {url_a}")
        filename_a = url_a.rsplit("filename=", 1)[-1].split("&")[0]

        # 2. edit (pass the generate output filename)
        print("[2/4] edit ...")
        url_b = edit_image(settings, image=filename_a, mode="edit",
                           prompt="make the apple bright green, keep everything else", seed=args.seed)
        print(f"      B: {url_b}")
        filename_b = url_b.rsplit("filename=", 1)[-1].split("&")[0]

        # 3. upscale (pass the edit output filename)
        print("[3/4] upscale ...")
        url_c = upscale_image(settings, image=filename_b, seed=args.seed)
        print(f"      C: {url_c}")
        filename_c = url_c.rsplit("filename=", 1)[-1].split("&")[0]

        # 4. video (pass the upscale output filename)
        print("[4/4] video (wan21, 81 frames) ...")
        url_d = generate_video(settings, image=filename_c, model_version="wan21",
                               prompt="the apple slowly rotates on the table", frames=81, seed=args.seed)
        print(f"      D: {url_d}")

    except Exception as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1

    print("\nChain PASSED — filenames passed between all steps:")
    print(f"  A generate: {filename_a}")
    print(f"  B edit:     {filename_b}")
    print(f"  C upscale:  {filename_c}")
    print(f"  D video:    {url_d.rsplit('filename=', 1)[-1].split('&')[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
