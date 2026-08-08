#!/usr/bin/env python3
"""Probe: does ComfyUI 0.29.1 stream per-step latent previews over the WS?

The ComfyUI web UI shows per-step previews WITHOUT any preview node — the
sampler itself decodes the intermediate latent (tiny VAE from
models/vae_approx, or latent2rgb) and sends the image as a binary WS
message. To receive them a client must:
  1. connect with ws?clientId=<id> and, as the FIRST WS message, send
     {"type": "feature_flags", "data": {"supports_preview_metadata": true}}
  2. queue the prompt with the same client_id AND
     extra_data={"preview_method": "auto"} (default CLI flag is
     NoPreviews, so without this the server generates no previews at all).

Usage:
  .venv/bin/python -u scripts/probe_previews.py [--family krea2|flux2|zimage] [--steps 4]
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import threading
import time
import uuid
from pathlib import Path

import httpx
from websockets.sync.client import connect as ws_connect

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BASE = "http://akari.home"
OUT_DIR = Path("/tmp/previews")
OUT_DIR.mkdir(exist_ok=True)

_events: list[str] = []
_binary: list[tuple[int, int, bytes | None]] = []  # (event_type, size, meta)


def run(family: str, steps: int) -> None:
    client_id = uuid.uuid4().hex
    ws_url = BASE.replace("http://", "ws://").replace("https://", "wss://") + f"/ws?clientId={client_id}"
    print(f"[probe] client_id={client_id[:8]} family={family} steps={steps}")

    from tools.generate import build_workflow, load_workflow

    wf, meta = build_workflow(
        load_workflow(), family=family, prompt="a red apple on a table",
        aspect_ratio="2:3", megapixel=1.0, steps=steps, seed=42,
    )
    prompt_id = None

    with ws_connect(ws_url, max_size=None, open_timeout=15) as ws:
        # 1) FIRST message: feature flags
        ws.send(json.dumps({"type": "feature_flags", "data": {"supports_preview_metadata": True}}))

        # 2) queue with the SAME client_id + preview_method in extra_data
        body = {"prompt": wf, "client_id": client_id, "extra_data": {"preview_method": "auto"}}
        with httpx.Client(timeout=30) as hx:
            r = hx.post(f"{BASE}/prompt", json=body)
            print(f"[probe] POST /prompt -> {r.status_code} {r.text[:160]}")
            pid = r.json().get("prompt_id")
            if not pid:
                print("[probe] queue failed"); return
            prompt_id = pid

        # 3) read the stream until execution_success/error
        n_bin = 0
        n_img = 0
        while True:
            try:
                raw = ws.recv(timeout=120)
            except Exception as e:
                print(f"[probe] recv error: {e}"); break
            if isinstance(raw, str):
                msg = json.loads(raw)
                t = msg.get("type")
                data = msg.get("data") or {}
                if t in ("progress", "progress_state", "executing", "executed", "execution_success", "execution_error", "status", "feature_flags", "execution_start"):
                    if t == "executed":
                        out = data.get("output", {})
                        imgs = len(out.get("images", []))
                        print(f"  [WS] {t} node={data.get('node')} images={imgs}")
                    elif t == "progress":
                        print(f"  [WS] progress {data.get('value')}/{data.get('max')} node={data.get('node')}")
                    elif t == "execution_success":
                        print(f"  [WS] EXECUTION SUCCESS"); break
                    elif t == "execution_error":
                        print(f"  [WS] EXECUTION ERROR: {str(data.get('exception_message'))[:200]}"); break
                    elif t == "progress_state":
                        nodes = data.get("nodes", {})
                        # only print compact
                        pass
                    else:
                        print(f"  [WS] {t} {str(data)[:100]}")
            elif isinstance(raw, (bytes, bytearray)):
                n_bin += 1
                event_type = struct.unpack(">I", raw[:4])[0]
                payload = bytes(raw[4:])
                meta = None
                if event_type == 4:  # PREVIEW_IMAGE_WITH_METADATA
                    mlen = struct.unpack(">I", payload[:4])[0]
                    meta = json.loads(payload[4:4 + mlen].decode("utf-8", "replace"))
                    img = payload[4 + mlen:]
                    n_img += 1
                    fname = OUT_DIR / f"{family}_s{steps}_p{n_img}.jpg"
                    fname.write_bytes(img)
                    print(f"  [BIN] event=4 PREVIEW_IMAGE_WITH_METADATA node={meta.get('node_id')} prompt={str(meta.get('prompt_id'))[:8]} img={fname.name} bytes={len(img)}")
                elif event_type == 1:  # legacy PREVIEW_IMAGE
                    imgtype = struct.unpack(">I", payload[:4])[0]
                    img = payload[4:]
                    n_img += 1
                    ext = "png" if imgtype == 2 else "jpg"
                    fname = OUT_DIR / f"{family}_s{steps}_legacy{n_img}.{ext}"
                    fname.write_bytes(img)
                    print(f"  [BIN] event=1 legacy PREVIEW_IMAGE type={imgtype} img={fname.name} bytes={len(img)}")
                else:
                    print(f"  [BIN] event={event_type} bytes={len(payload)}")
                _binary.append((event_type, len(payload), meta))

    print(f"\n[probe] RESULT: binary_msgs={n_bin} preview_images={n_img} (saved in {OUT_DIR})")
    print(f"[probe] RESULT: {json.dumps({'family': family, 'preview_images': n_img, 'prompt_id': prompt_id})}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--family", default="flux2", choices=["flux2", "krea2", "zimage"])
    p.add_argument("--steps", type=int, default=4)
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    BASE = args.base
    run(args.family, args.steps)
