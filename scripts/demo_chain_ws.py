#!/usr/bin/env python3
"""Chain generate -> edit -> upscale through the REAL tools, with a SHARED
clientId for POST /prompt and the WebSocket, logging every WS event per job.

Shows per-node execution (executing node=N + title) and numeric progress
(value/max) for each stage, like B5 would expose in the UI.

Usage:  .venv/bin/python -u scripts/demo_chain_ws.py [--base http://akari.home]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import websockets

from tools import _common
from tools.generate import load_workflow as gen_wf, build_workflow as gen_build
from tools.edit import load_workflow as edit_wf, build_workflow as edit_build
from tools.upscale import load_workflow as up_wf, build_workflow as up_build

PROMPT_GEN = "a red apple on a wooden table, studio lighting, photorealistic"
PROMPT_EDIT = "make the apple bright green, keep everything else the same"


def node_titles(wf: dict) -> dict[str, str]:
    """node_id -> _meta.title for pretty logging."""
    out = {}
    for nid, node in wf.items():
        if isinstance(node, dict):
            out[str(nid)] = node.get("_meta", {}).get("title", node.get("class_type", nid))
    return out


class Runner:
    def __init__(self, base: str):
        self.base = base
        self.client_id = str(uuid.uuid4())
        self.titles: dict[str, dict[str, str]] = {}  # prompt_id -> node map
        self.queue: asyncio.Queue = asyncio.Queue()
        self.done: asyncio.Event = asyncio.Event()
        self.current_pid: str | None = None
        self.success: bool = False

    def ts(self) -> str:
        return time.strftime("%H:%M:%S")

    async def ws_loop(self, ws) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("type")
            data = msg.get("data", {})
            if not isinstance(data, dict):
                continue
            pid = str(data.get("prompt_id", ""))[:8]
            # only follow the job we launched (compare truncated ids)
            if self.current_pid and pid and pid != self.current_pid[:8]:
                continue
            titles = self.titles.get(self.current_pid, {})
            ts = self.ts()

            if t == "executing":
                node = data.get("node")
                label = titles.get(str(node), "?")
                if node is None:
                    print(f"[WS {ts}] ◀ fin")
                else:
                    print(f"[WS {ts}] ▶ node {node} \"{label}\"")
            elif t == "progress":
                v, m = data.get("value"), data.get("max")
                if m:
                    print(f"[WS {ts}]    progress {v}/{m} ({100 * v // m}%)")
            elif t == "executed":
                out = data.get("output", {})
                kind = "images" if out.get("images") else ("videos" if out.get("videos") else "gifs" if out.get("gifs") else "?")
                n = len(out.get(kind, [])) if isinstance(out.get(kind), list) else 0
                label = titles.get(str(data.get("node")), "?")
                print(f"[WS {ts}] ✓ node {data.get('node')} \"{label}\" output {kind}={n}")
            elif t == "execution_success":
                self.success = True
                print(f"[WS {ts}] ✅ SUCCESS")
                self.done.set()
            elif t == "execution_error":
                self.success = False
                print(f"[WS {ts}] ❌ ERROR: {json.dumps(data.get('exception_message', data))[:300]}")
                self.done.set()
            elif t == "execution_start":
                print(f"[WS {ts}] ▶ start prompt={pid}")
            elif t == "status":
                rem = data.get("status", {}).get("exec_info", {}).get("queue_remaining")
                if self.current_pid and rem is not None:
                    print(f"[WS {ts}]    queue_remaining={rem}")

    async def run_job(self, ws, hx, wf: dict, label: str) -> dict | None:
        """Queue one workflow, follow its events on the WS, return outputs."""
        r = await hx.post(f"{self.base}/prompt", json={"prompt": wf, "client_id": self.client_id})
        body = r.json()
        if "prompt_id" not in body:
            print(f"[{label}] queue error: {json.dumps(body)[:300]}")
            return None
        pid = body["prompt_id"]
        self.current_pid = pid
        self.titles[pid[:8]] = node_titles(wf)
        self.done.clear()
        self.success = False
        print(f"\n═══ [{label}] queued {pid[:8]} (client_id={self.client_id[:8]}) ═══")
        try:
            await asyncio.wait_for(self.done.wait(), timeout=300)
        except asyncio.TimeoutError:
            print(f"[{label}] timeout")
            return None
        if not self.success:
            return None
        # fetch outputs from history
        h = (await hx.get(f"{self.base}/history/{pid}")).json()
        entry = h.get(pid, {})
        return entry.get("outputs", {})

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=30) as hx:
            ws_url = self.base.replace("http://", "ws://").replace("https://", "wss://").rstrip("/")
            async with websockets.connect(f"{ws_url}/ws?clientId={self.client_id}", max_size=None) as ws:
                ws_task = asyncio.create_task(self.ws_loop(ws))
                try:
                    # 1) GENERATE
                    wf, meta = gen_build(gen_wf(), family="krea2", prompt=PROMPT_GEN, seed=42)
                    outs = await self.run_job(ws, hx, wf, "1 GENERATE (krea2)")
                    if not outs:
                        return 1
                    img = _common.find_output_image(outs)
                    fn1 = img["filename"]
                    print(f"      -> imagen: {fn1}")

                    # 2) EDIT
                    wf2, _ = edit_build(edit_wf(), image=fn1, mode="edit", prompt=PROMPT_EDIT, seed=42)
                    outs2 = await self.run_job(ws, hx, wf2, "2 EDIT (flux2-klein)")
                    if not outs2:
                        return 1
                    img2 = _common.find_output_image(outs2)
                    fn2 = img2["filename"]
                    print(f"      -> edit: {fn2}")

                    # 3) UPSCALE
                    wf3, _ = up_build(up_wf(), image=fn2, seed=42)
                    outs3 = await self.run_job(ws, hx, wf3, "3 UPSCALE (seedvr2)")
                    if not outs3:
                        return 1
                    img3 = _common.find_output_image(outs3)
                    print(f"      -> upscale: {img3['filename']}")
                    print("\n✅ Cadena completa: generate -> edit -> upscale")
                    return 0
                finally:
                    ws_task.cancel()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://akari.home")
    args = p.parse_args()
    sys_exit = asyncio.run(Runner(args.base).run())
    raise SystemExit(sys_exit or 0)
