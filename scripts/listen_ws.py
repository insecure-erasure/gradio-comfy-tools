#!/usr/bin/env python3
"""Subscribe to the ComfyUI WebSocket and log every event.

Usage:
  .venv/bin/python -u scripts/listen_ws.py [--base http://akari.home] [--seconds 300]
  .venv/bin/python -u scripts/listen_ws.py --no-selftest   # don't queue the self-test prompt

Notes:
  - Per-node events (executing/progress/executed) are filtered by the
    clientId that queued the prompt: with a fresh socket clientId you only
    get global `status` + `crystools.monitor`. To demonstrate the full
    stream we queue a tiny prompt with the SAME clientId (--selftest,
    default on).
  - GET /queue items are lists: [prompt_id, number, ...].
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid

import httpx
import websockets


# ── REST helpers ────────────────────────────────────────────────────────── #
def _qitem_id(item) -> str:
    """prompt id from a /queue item (list [pid, number, ...] or dict)."""
    try:
        if isinstance(item, list) and item:
            return str(item[0])[:8]
        if isinstance(item, dict):
            return str(item.get("prompt_id", item.get("id", "")))[:8]
    except Exception:
        pass
    return "?"


async def rest_snapshot(client: httpx.AsyncClient, base: str) -> None:
    ts = time.strftime("%H:%M:%S")
    try:
        rq = await client.get(f"{base}/queue")
        q = rq.json()
        if not isinstance(q, dict):
            print(f"[REST {ts}] /queue unexpected payload: {str(q)[:200]}")
            return
        running = [_qitem_id(p) for p in q.get("queue_running", [])]
        pending = [_qitem_id(p) for p in q.get("queue_pending", [])]
    except Exception as e:
        print(f"[REST {ts}] /queue error: {e}")
        return
    try:
        rp = await client.get(f"{base}/prompt")
        p = rp.json()
        if not isinstance(p, dict):
            print(f"[REST {ts}] /prompt unexpected payload: {str(p)[:200]}")
            return
        remaining = p.get("exec_info", {}).get("queue_remaining")
    except Exception as e:
        print(f"[REST {ts}] /prompt error: {e}")
        return
    print(f"[REST {ts}] running={running} pending={pending} queue_remaining={remaining}")


# Tiny prompt queued with OUR clientId so we receive its per-node events.
SELFTEST_WF = {
    "1": {
        "class_type": "LoadImageByUrlOrPath",
        "inputs": {
            "source": "temp",
            "image": "ComfyUI_temp_20260807T230733_1d94822ba344.png",
            "url": "",
        },
    },
    "2": {"class_type": "GetImageSize", "inputs": {"image": ["1", 0]}},
    "3": {"class_type": "RandomPreviewImage", "inputs": {"images": ["1", 0]}},
}


async def selftest(base: str, client_id: str) -> None:
    """Queue a tiny workflow with our client_id (events come to our socket)."""
    await asyncio.sleep(5)
    ts = time.strftime("%H:%M:%S")
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{base}/prompt",
                json={"prompt": SELFTEST_WF, "client_id": client_id},
            )
            body = r.json()
            if "prompt_id" in body:
                print(f"[SELFTEST {ts}] queued prompt_id={body['prompt_id'][:8]} (client_id={client_id[:8]})")
            else:
                print(f"[SELFTEST {ts}] queue error: {json.dumps(body)[:300]}")
    except Exception as e:
        print(f"[SELFTEST {ts}] error: {e}")


# ── WS event formatting ─────────────────────────────────────────────────── #
def fmt_event(event: str, data: dict) -> str:
    ts = time.strftime("%H:%M:%S")
    if event == "executing":
        return f"[WS {ts}] executing  node={data.get('node')} prompt={(data.get('prompt_id') or '')[:8]}"
    if event == "progress":
        return (
            f"[WS {ts}] progress   {data.get('value')}/{data.get('max')} "
            f"node={data.get('node')} prompt={(data.get('prompt_id') or '')[:8]}"
        )
    if event == "executed":
        out = data.get("output", {})
        imgs, gifs, vids = out.get("images", []), out.get("gifs", []), out.get("videos", [])
        n = len(imgs) + len(gifs) + len(vids)
        kind = "images" if imgs else ("gifs" if gifs else ("videos" if vids else "?"))
        return (
            f"[WS {ts}] executed   node={data.get('node')} {kind}={n} "
            f"keys={list(out.keys())} prompt={(data.get('prompt_id') or '')[:8]}"
        )
    if event == "status":
        return f"[WS {ts}] status     {json.dumps(data.get('status', {}))[:160]}"
    if event == "execution_success":
        return f"[WS {ts}] EXECUTION SUCCESS prompt={(data.get('prompt_id') or '')[:8]}"
    if event == "execution_error":
        return f"[WS {ts}] EXECUTION ERROR prompt={(data.get('prompt_id') or '')[:8]}"
    if event == "execution_start":
        return f"[WS {ts}] execution_start prompt={(data.get('prompt_id') or '')[:8]}"
    if event == "execution_cached":
        return f"[WS {ts}] execution_cached nodes={data.get('nodes')}"
    if event == "crystools.monitor":
        # too noisy every second — print only a compact line
        m = data
        if isinstance(m, dict):
            gpu = None
            gpus = m.get("gpus")
            if isinstance(gpus, list) and gpus and isinstance(gpus[0], dict):
                gpu = gpus[0].get("gpu_utilization")
            return f"[WS {ts}] crystools  gpu={gpu}% ram_pct={m.get('ram_used_percent')} vram_pct={gpus[0].get('vram_used_percent') if isinstance(gpus, list) and gpus and isinstance(gpus[0], dict) else '?'}"
        return f"[WS {ts}] crystools  ?"
    return f"[WS {ts}] {event} {json.dumps(data)[:200]}"


async def main(base: str, seconds: int, do_selftest: bool) -> None:
    client_id = str(uuid.uuid4())
    url = base.replace("http://", "ws://").replace("https://", "wss://").rstrip("/")
    url = f"{url}/ws?clientId={client_id}"
    print(f"client_id: {client_id}")
    print(f"connecting to {url}")
    print("(Ctrl-C to stop)")

    async with httpx.AsyncClient(timeout=15) as hx:
        async with websockets.connect(url, max_size=None) as ws:
            await rest_snapshot(hx, base)

            async def rest_loop():
                while True:
                    await asyncio.sleep(3)
                    await rest_snapshot(hx, base)

            async def ws_loop():
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        print(f"[WS raw] {raw!r}")
                        continue
                    print(fmt_event(msg.get("type"), msg.get("data", {})))

            tasks = [rest_loop(), ws_loop()]
            if do_selftest:
                tasks.append(selftest(base, client_id))
            await asyncio.wait_for(asyncio.gather(*tasks), timeout=seconds)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://akari.home")
    p.add_argument("--seconds", type=int, default=300)
    p.add_argument("--no-selftest", action="store_true")
    args = p.parse_args()
    try:
        asyncio.run(main(args.base, args.seconds, not args.no_selftest))
    except asyncio.TimeoutError:
        print("timeout — done")
    except KeyboardInterrupt:
        print("stopped")
