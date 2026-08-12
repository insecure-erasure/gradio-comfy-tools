#!/usr/bin/env python3
"""A0 smoke test against a live ComfyUI.

Validates the full REST contract end to end:
    health -> upload (temp) -> queue a trivial workflow (load+save)
           -> poll history -> result URL (verifies it serves 200)

Usage:
    python3 dev/smoke_client.py [BASE_URL]
"""

from __future__ import annotations

import sys
import tempfile
import struct
import zlib
from pathlib import Path

# make repo root importable when run as `python3 dev/smoke_client.py`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from comfy_client import ComfyClient  # noqa: E402
from config import Settings  # noqa: E402


def make_png(path: Path, w: int = 64, h: int = 64, rgb: tuple = (120, 40, 200)) -> None:
    """Write a minimal valid PNG (solid color)."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB, no interlace
    row = b"\x00" + bytes(rgb) * w
    idat = zlib.compress(row * h)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else None
    settings = Settings()
    if base:
        settings.comfyui_base_url = base.rstrip("/")
    print(f"ComfyUI base: {settings.comfyui_base_url}")
    print(f"Media base:   {settings.media_base_url}")

    with ComfyClient(settings=settings) as client:
        # 1. health
        stats = client.health()
        ver = stats["system"]["comfyui_version"]
        print(f"[1/5] health OK (ComfyUI {ver})")

        # 2. upload
        with tempfile.TemporaryDirectory() as tmp:
            png = Path(tmp) / "smoke.png"
            make_png(png)
            filename = client.upload_image(png)
            print(f"[2/5] uploaded -> {filename}")

            # 3. queue a trivial workflow: load the uploaded temp image + save
            workflow = {
                "1": {
                    "class_type": "LoadImageByUrlOrPath",
                    "inputs": {"source": "temp", "image": filename, "url": ""},
                },
                "2": {
                    "class_type": "SaveImage",
                    "inputs": {"images": ["1", 0], "filename_prefix": "smoke_a0"},
                },
            }
            prompt_id = client.queue_prompt(workflow)
            print(f"[3/5] queued -> prompt_id {prompt_id}")

            # 4. poll
            outputs = client.wait_for_output(prompt_id, timeout=120, poll=1.0)
            saved = None
            for node_out in outputs.values():
                for img in node_out.get("images", []):
                    saved = img
                    break
                if saved:
                    break
            if not saved:
                print(f"[FAIL] no image output in {outputs}", file=sys.stderr)
                return 1
            out_filename = saved["filename"]
            out_type = saved.get("type", "output")
            print(f"[4/5] output -> {out_filename} (type={out_type})")

            # 5. result URL serves the file
            url = client.result_url(out_filename, out_type)
            print(f"[5/5] result URL: {url}")
            with httpx.Client(timeout=15) as hc:
                resp = hc.get(url)
                if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image"):
                    print("      URL serves the image (200 image/*) — open it in the browser")
                else:
                    print(f"[FAIL] URL returned {resp.status_code} {resp.headers.get('content-type')}", file=sys.stderr)
                    return 1

    print("\nSmoke test PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
