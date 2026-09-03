"""Backend API server — serves the modular frontend (templates/ + static/).

The UI (a working copy of the mockup, split into Jinja2 partials + static
CSS/JS) is rendered at `/`; its JS actions call these endpoints, which run
the validated tools in `tools/`. Images/videos are proxied through
`/media/...` so the browser never talks to the ComfyUI host directly (no
CORS/host validation issues).

Endpoints:
    GET  /                        the UI (templates/index.html)
    GET  /health                  server + ComfyUI health
    POST /api/generate            Generate tab
    POST /api/edit                Edit tab
    POST /api/upscale             Upscale tab
    POST /api/video               Video tab
    POST /api/upload              upload an image to ComfyUI (temp)
    GET  /media/{filename}?type=  proxy a result file from ComfyUI
    POST /api/check-image         validate that a URL/filename is an image
    GET/POST /api/settings        global settings (for the 🎨 menu)
    WS   /ws/progress             live generation progress push (frontend no longer polls)

Run:  .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import base64
import json
import struct
import threading
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

import comfy_client
from config import Settings
from tools.edit import edit_image, MODES
from tools.face_swap import face_swap_image
from tools.generate import FAMILY_OPTIONS, generate_image
from tools.upscale import upscale_image
from tools.video import MODEL_VERSIONS, generate_video

REPO = Path(__file__).resolve().parent

# Modular frontend: docs/mockup.html stays as the design template/spec, the
# working copy is split into Jinja2 partials (templates/) + static assets.
TEMPLATES = Jinja2Templates(directory=REPO / "templates")
STATIC_DIR = REPO / "static"

app = FastAPI(title="Comfy Tools")


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles that always revalidates (Cache-Control: no-cache) so a
    stale browser tab never keeps running old JS/CSS after a deploy — the
    gallery bug that surfaced as "only the last generated image shows" was
    the browser running the pre-fix gallery.js from cache.
    """

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers.setdefault("Cache-Control", "no-cache")
        return resp


app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")


def _asset_version() -> str:
    """A short hash of the static assets (path + mtime), so the UI can
    cache-bust script/css URLs (?v=...) — a reload ALWAYS fetches the
    current JS/CSS, even from a tab that cached the old page heuristically.
    Changes whenever any file under static/ changes.
    """
    import hashlib

    h = hashlib.sha1()
    try:
        entries = sorted((p.relative_to(STATIC_DIR).as_posix(), p.stat().st_mtime_ns)
                         for p in STATIC_DIR.rglob("*") if p.is_file())
    except OSError:
        entries = []
    for name, mtime in entries:
        h.update(name.encode("utf-8", "replace"))
        h.update(str(mtime).encode())
    return h.hexdigest()[:10]


ASSET_VERSION = _asset_version()


def _settings() -> Settings:
    return Settings()


def _filename_from_url(url: str) -> tuple[str, str]:
    """(filename, type) parsed from a ComfyUI result URL."""
    query = url.rsplit("?", 1)[-1]
    parts = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
    return parts.get("filename", ""), parts.get("type", "output")


# --------------------------------------------------------------------------- #
# Live progress (B5-lite) — pushed over WebSocket, /api/progress as fallback
#
# Every queue_prompt fires a hook (see comfy_client.register_prompt_hook) that
# spawns a daemon thread: it opens a WebSocket to ComfyUI with the SAME
# clientId used for POST /prompt, follows that prompt's events (executing /
# progress / executed / execution_success) and updates an in-memory job store.
# Every mutation of the store (stage, step value/max, per-step preview,
# completion) is PUSHED to the browser over /ws/progress (see _broadcast_progress),
# so the frontend no longer polls. GET /api/progress remains as the payload
# source for the polling fallback (WS down) and for the tests.
# --------------------------------------------------------------------------- #
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_MAX_JOBS = 20

# Which tool/prompt is about to be queued — set by the API handlers BEFORE
# calling the generate_* tool (which queues the workflow and fires the hook).
# The hook reads these to tag the resulting prompt_id with its tool/prompt
# (the result is then recorded with the right tool/prompt in history).
# Thread-safe (GIL-atomic dict ops); the single-user app has one request at a
# time, and the value is consumed by the hook synchronously.
_pending_tool: str = ""
_pending_prompt: str = ""

live_job_tool: dict[str, str] = {}
live_job_prompt: dict[str, str] = {}


def _node_titles(workflow: dict) -> dict[str, str]:
    """node_id -> _meta.title (or class_type) for readable progress labels."""
    out: dict[str, str] = {}
    for nid, node in workflow.items():
        if isinstance(node, dict):
            out[str(nid)] = node.get("_meta", {}).get("title") or node.get("class_type", str(nid))
    return out


def _handle_ws_binary(raw: bytes, prompt_id: str) -> None:
    """Parse a binary WS message and store the per-step latent preview.

    ComfyUI streams previews as binary frames (only when the client declared
    ``supports_preview_metadata`` on connect AND the prompt was queued with
    ``extra_data.preview_method``):

        event 4 (PREVIEW_IMAGE_WITH_METADATA):
            >I(4) + >I(len_json) + JSON{node_id, prompt_id, ...} + JPEG
        event 1 (legacy PREVIEW_IMAGE):
            >I(4) + >I(image_type: 1=jpeg, 2=png) + bytes

    Only the LAST preview per job is kept (each frame overwrites the
    previous), so memory stays bounded: one job holds at most one ~50KB
    JPEG. The preview is dropped when the job finishes (see _mark_job_result)
    — it is ephemeral and intentionally lost on cancel.
    """
    try:
        event = struct.unpack(">I", raw[:4])[0]
        payload = raw[4:]
        jpg: bytes | None = None
        if event == 4:  # PREVIEW_IMAGE_WITH_METADATA
            mlen = struct.unpack(">I", payload[:4])[0]
            jpg = payload[4 + mlen :]
        elif event == 1:  # legacy PREVIEW_IMAGE
            jpg = payload[4:]  # drop the >I image_type
        else:
            return
        if not jpg:
            return
        with _jobs_lock:
            job = _jobs.get(prompt_id)
            if job is not None:
                job["preview"] = jpg
        if job is not None:
            _broadcast_progress(job)  # push the new preview frame to the UI
    except Exception:
        pass  # best-effort: never let a malformed frame kill the listener


def _listen_job_ws(base_url: str, client_id: str, prompt_id: str, titles: dict[str, str]) -> None:
    """Daemon thread: follow one job's events on the ComfyUI WebSocket."""
    try:
        from websockets.sync.client import connect

        ws_url = (
            base_url.replace("http://", "ws://").replace("https://", "wss://")
            + f"/ws?clientId={client_id}"
        )
        with connect(ws_url, open_timeout=10, close_timeout=3) as ws:
            # Declare preview support as the FIRST message: the server only
            # sends preview images to clients that opt in per-connection
            # (same handshake the ComfyUI web frontend does).
            try:
                ws.send(json.dumps({"type": "feature_flags", "data": {"supports_preview_metadata": True}}))
            except Exception:
                pass
            for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    _handle_ws_binary(bytes(raw), prompt_id)
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                data = msg.get("data") or {}
                if str(data.get("prompt_id", "")) != prompt_id:
                    continue
                t = msg.get("type")
                with _jobs_lock:
                    job = _jobs.get(prompt_id)
                    if job is None:
                        continue
                    if t == "executing":
                        node = data.get("node")
                        job["stage"] = "running" if node is not None else "finishing"
                        job["node"] = node
                        job["node_title"] = (
                            titles.get(str(node), str(node)) if node is not None else None
                        )
                    elif t == "progress":
                        job["value"] = data.get("value")
                        job["max"] = data.get("max")
                    elif t == "execution_success":
                        job["done"] = True
                    elif t == "execution_error":
                        job["done"] = True
                        job["error"] = str(data.get("exception_message", "execution error"))[:300]
                # Record the result URL OUTSIDE the lock, in a SEPARATE
                # thread. _record_job_output acquires _jobs_lock itself (via
                # _mark_job_result) and threading.Lock is NOT reentrant —
                # calling it while holding the lock deadlocked the listener
                # thread (and every other thread that needed the lock,
                # including the API handlers and the completion broadcast)
                # the moment a job finished. A separate thread also keeps a
                # slow history fetch (up to 60s) from stalling the WS recv
                # loop (keepalive pings) or the done broadcast below.
                if t == "execution_success":
                    threading.Thread(
                        target=_record_job_output,
                        args=(prompt_id, live_job_tool.get(prompt_id, "")),
                        kwargs={
                            "prompt": live_job_prompt.get(prompt_id, ""),
                            "titles": titles,
                        },
                        daemon=True,
                    ).start()
                _broadcast_progress(job)  # push the stage/value/preview update
                if t in ("execution_success", "execution_error"):
                    break
    except Exception as e:  # WS is best-effort — polling still finishes the job
        with _jobs_lock:
            job = _jobs.get(prompt_id)
            if job is not None:
                job["ws_error"] = str(e)[:200]


def _start_job_listener(client_id: str, prompt_id: str, workflow: dict) -> None:
    """Register the job and spawn its WS listener thread."""
    base = _settings().comfyui_base_url.rstrip("/")
    with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:  # prune oldest jobs
            for k in sorted(_jobs, key=lambda k: _jobs[k].get("started", 0))[: len(_jobs) - _MAX_JOBS + 1]:
                _jobs.pop(k, None)
        _jobs[prompt_id] = {
            "prompt_id": prompt_id,
            "started": time.time(),
            "stage": "queued",
            "node": None,
            "node_title": None,
            "value": None,
            "max": None,
            "done": False,
            "error": None,
            "tool": live_job_tool.get(prompt_id, ""),
            "prompt": live_job_prompt.get(prompt_id, ""),
        }
    threading.Thread(
        target=_listen_job_ws,
        args=(base, client_id, prompt_id, _node_titles(workflow)),
        daemon=True,
    ).start()
    with _jobs_lock:
        _broadcast_progress(_jobs.get(prompt_id))  # push the "queued" state


def _record_job_output(
    prompt_id: str, tool: str = "", prompt: str = "", titles: dict | None = None
) -> None:
    """Best-effort: record a completed job's result URL from ComfyUI history.

    Called from a dedicated thread spawned by the job's WS listener on
    execution_success, so the result is recorded even when the HTTP handler's
    wait_for_output timed out (videos can outlive it) or the client
    disconnected mid-job. The handler's _mark_latest_done remains as a second,
    idempotent record path — whichever runs first wins, and _mark_job_result
    is safe to call twice.

    ``titles`` is the node_id -> title map of the submitted workflow (the WS
    listener has it); the Face swap workflow ends in TWO preview nodes, so
    its result must be resolved by node title — never the first image
    (the extracted-face preview is recorded first).

    WARNING: must never be called while holding _jobs_lock — it acquires the
    lock itself (via _mark_job_result) and threading.Lock is not reentrant;
    calling it under the lock deadlocks the whole backend (the caller holds
    the lock forever and every other thread that needs it blocks).
    """
    try:
        from comfy_client import ComfyClient
        from tools import _common

        with ComfyClient(settings=_settings()) as c:
            # History is normally already populated when execution_success
            # fires; the generous timeout covers any tiny write lag.
            outputs = c.wait_for_output(prompt_id, timeout=60, poll=1)
            rec = None
            if tool == "face_swap":
                try:
                    from tools.face_swap import select_result_images

                    main, _ = select_result_images(outputs, titles or {})
                    if main is not None:
                        rec = main
                except Exception:
                    rec = None  # fall back to the generic pick below
            if rec is None:
                try:
                    rec = _common.find_output_image(outputs)
                except _common.WorkflowError:
                    rec = _common.find_output_video(outputs)
            url = c.result_url(rec["filename"], rec.get("type", "output"))
        _mark_job_result(prompt_id, url, tool=tool, prompt=prompt)
    except Exception:
        pass  # best-effort — the handler's _mark_latest_done is the fallback


def _mark_job_result(prompt_id: str, url: str, tool: str = "", prompt: str = "") -> None:
    """Mark a job done and attach its result URL.

    The per-step preview is dropped here (and on cancel, where url=None):
    previews are ephemeral — once the real result is ready (or the job was
    cancelled) keeping them would only hold memory. Later calls are
    idempotent.
    """
    new_result = False
    with _jobs_lock:
        job = _jobs.get(prompt_id)
        if job is not None:
            new_result = bool(url) and not job.get("url")
            job["done"] = True
            job["url"] = url
            job.pop("preview", None)
    if job is not None:
        _broadcast_progress(job)  # push "active: null" — the job settled


# --------------------------------------------------------------------------- #
# Live progress push (WebSocket)
#
# The frontend used to poll GET /api/progress every second; instead the
# backend now PUSHES every job update over /ws/progress. The push channel is
# fed from the same places that mutate _jobs — the per-job ComfyUI WS
# listener threads, the binary preview handler and the result marker — via
# loop.call_soon_threadsafe, so updates from any thread land on the event
# loop and are fanned out to every connected client. The frontend keeps the
# 1s polling as an automatic fallback when the WS fails (proxy/old server).
# --------------------------------------------------------------------------- #
_progress_clients: dict[WebSocket, asyncio.Queue] = {}
_progress_clients_lock = threading.Lock()
_ws_loop: asyncio.AbstractEventLoop | None = None
_WS_SENTINEL = object()


def _progress_payload(job: dict | None) -> dict:
    """The wire payload for one job state, shared by GET /api/progress and
    the /ws/progress push: {"active": {...}} while a job runs (the per-step
    preview included when the job requested previews), {"active": None}
    otherwise."""
    if job is None or job.get("done"):
        return {"active": None}
    active = {k: job.get(k) for k in ("prompt_id", "stage", "node", "node_title", "value", "max")}
    pv = job.get("preview")
    if pv:
        active["preview"] = "data:image/jpeg;base64," + base64.b64encode(pv).decode("ascii")
    return {"active": active}


def _broadcast_progress(job: dict | None) -> None:
    """Push the current job state to every connected /ws/progress client.

    Safe to call from ANY thread (the per-job ComfyUI listener threads call
    it): the payload is queued onto the event loop via call_soon_threadsafe
    and each client's sender task serializes the sends, so concurrent
    updates can never interleave on one socket.
    """
    if not _progress_clients:
        return
    loop = _ws_loop
    if loop is None:
        return
    payload = _progress_payload(job)
    with _progress_clients_lock:
        clients = list(_progress_clients.values())
    for q in clients:
        loop.call_soon_threadsafe(q.put_nowait, payload)


@app.websocket("/ws/progress")
async def ws_progress(ws: WebSocket) -> None:
    """Push channel for live generation progress.

    On connect the client immediately receives the current job snapshot
    ({"active": {...}} or {"active": null}); every subsequent job update
    (stage, step value/max, per-step preview, completion) is pushed as it
    happens — the frontend no longer needs to poll. The connection stays
    open until the client disconnects; if it drops, the frontend falls back
    to polling and reconnects on the next job.
    """
    global _ws_loop
    await ws.accept()
    _ws_loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    with _progress_clients_lock:
        _progress_clients[ws] = q
    # Snapshot immediately so the client does not wait for the next update.
    try:
        await ws.send_json(_progress_payload(_latest_job()))
    except Exception:
        pass

    async def sender() -> None:
        while True:
            payload = await q.get()
            if payload is _WS_SENTINEL:
                break
            try:
                await ws.send_json(payload)
            except Exception:
                break

    task = asyncio.create_task(sender())
    try:
        while True:
            await ws.receive_text()  # client sends nothing — wait for disconnect
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        task.cancel()
        with _progress_clients_lock:
            _progress_clients.pop(ws, None)


def _latest_job() -> dict | None:
    with _jobs_lock:
        if not _jobs:
            return None
        return max(_jobs.values(), key=lambda j: j.get("started", 0))


def _mark_latest_done(url: str, tool: str = "", prompt: str = "") -> None:
    """Attach the result URL to the most recent job (single-user app)."""
    job = _latest_job()
    if job is not None:
        _mark_job_result(job["prompt_id"], url, tool=tool, prompt=prompt)


def _on_prompt_queued(client_id: str, prompt_id: str, workflow: dict) -> None:
    # Tag the job with the tool/prompt that queued it (set by the API
    # handler just before calling the generate_* tool). The result is then
    # recorded in history with the right tool/prompt.
    live_job_tool[prompt_id] = _pending_tool
    live_job_prompt[prompt_id] = _pending_prompt
    _start_job_listener(client_id, prompt_id, workflow)


comfy_client.register_prompt_hook(_on_prompt_queued)


# --------------------------------------------------------------------------- #
# UI + health
# --------------------------------------------------------------------------- #
@app.get("/")
def index(request: Request) -> Response:
    resp = TEMPLATES.TemplateResponse(request, "index.html", {"asset_version": ASSET_VERSION})
    # The HTML shell must never be cached: a stale index (heuristic cache)
    # could keep a tab on old ?v= URLs. Static assets themselves are
    # revalidated (NoCacheStaticFiles) AND versioned below, so a refresh
    # always runs the current JS/CSS.
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/health")
def health() -> dict:
    s = _settings()
    try:
        from comfy_client import ComfyClient

        with ComfyClient(settings=s) as c:
            stats = c.health()
            version = stats["system"]["comfyui_version"]
        return {
            "ok": True,
            "comfyui_version": version,
            "comfyui_base_url": s.comfyui_base_url,
            "media_base_url": s.media_base_url,
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "comfyui_base_url": s.comfyui_base_url}


@app.get("/api/progress")
def api_progress() -> dict:
    """Live progress of the most recent job (single-user app).

    Returns ``{"active": {...}}`` while a job runs, ``{"active": null}``
    otherwise. While the job runs, ``active.preview`` carries the latest
    per-step latent preview (data URL, image/jpeg) when the job's workflow
    requested previews (Generate / Edit / Video) — the frontend shows it
    only in the tab that started the generation. The preview is dropped as
    soon as the job finishes, so it is never served stale.

    The primary channel for the frontend is the /ws/progress push; this
    endpoint stays as the payload source for the polling fallback (WS
    unavailable) and the tests.
    """
    return _progress_payload(_latest_job())


@app.get("/api/last-result")
def api_last_result() -> dict:
    """URL of the last COMPLETED job (single-user app).

    Used to recover a result when the browser suspended/throttled the
    frontend (background tab) and the in-flight fetch was aborted: the
    backend keeps running and finishes the job, so the frontend can poll
    this after regaining focus and resolve the result URL it missed.
    Returns ``{"url": ...}`` or ``{"url": null}``.
    """
    job = _latest_job()
    if job is None or not job.get("done"):
        return {"url": None}
    return {"url": job.get("url") or None}


@app.post("/api/cancel")
def api_cancel() -> dict:
    """Cancel the most recent job: interrupt what is running and remove it
    from the pending queue. Marks the job done so /api/progress goes idle
    and the frontend restores the copy button.
    """
    from comfy_client import ComfyClient

    s = _settings()
    job = _latest_job()
    pid = job["prompt_id"] if job else None
    result = {"ok": True, "prompt_id": pid, "interrupt": False, "delete": False}
    with ComfyClient(settings=s) as c:
        try:
            c.interrupt()
            result["interrupt"] = True
        except Exception:
            pass  # nothing running — fine
        if pid:
            try:
                c.cancel_prompt(pid)
                result["delete"] = True
            except Exception:
                pass  # already finished — fine
    if job is not None:
        _mark_job_result(pid, None)  # done, no result URL
    return result


@app.get("/api/loras")
def api_loras() -> dict:
    """List LoRA models from ComfyUI (GET {COMFYUI_BASE_URL}/models/loras)."""
    s = _settings()
    try:
        from comfy_client import ComfyClient

        with ComfyClient(settings=s) as c:
            loras = c.list_loras()
        return {"loras": loras}
    except Exception as e:
        raise HTTPException(502, f"Could not fetch LoRAs from ComfyUI: {e}") from e


@app.get("/api/diffusion-models")
def api_diffusion_models() -> dict:
    """List diffusion models from ComfyUI (GET {COMFYUI_BASE_URL}/models/diffusion_models)."""
    s = _settings()
    try:
        from comfy_client import ComfyClient

        with ComfyClient(settings=s) as c:
            models = c.list_diffusion_models()
        return {"models": models}
    except Exception as e:
        raise HTTPException(502, f"Could not fetch diffusion models from ComfyUI: {e}") from e


# --------------------------------------------------------------------------- #
# Tool endpoints
# --------------------------------------------------------------------------- #
def _tool_response(url: str) -> dict:
    filename, type_ = _filename_from_url(url)
    return {
        "url": url,          # direct ComfyUI URL (for copy / chaining)
        "display": f"/media/{filename}?type={type_}",  # same-origin proxy
        "filename": filename,
        "type": type_,
    }


@app.post("/api/generate")
def api_generate(body: dict) -> dict:
    s = _settings()
    try:
        global _pending_tool, _pending_prompt
        _pending_tool = "generate"
        _pending_prompt = str(body.get("prompt", ""))
        url = generate_image(
            s,
            family=str(body.get("family", "zimage")),
            prompt=str(body.get("prompt", "")),
            aspect_ratio=str(body.get("aspect_ratio", "2:3")),
            megapixel=float(body.get("megapixel", 1.0)),
            steps=int(body.get("steps", 0)),
            seed=int(body.get("seed", -1)),
            lora_config=str(body.get("lora_config", "[]")),
            model=str(body.get("model", "")),
        )
        _mark_latest_done(url, tool="generate", prompt=str(body.get("prompt", "")))
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


@app.post("/api/edit")
def api_edit(body: dict) -> dict:
    s = _settings()
    try:
        global _pending_tool, _pending_prompt
        _pending_tool = "edit"
        _pending_prompt = str(body.get("prompt", ""))
        url = edit_image(
            s,
            image=str(body.get("image", "")),
            mode=str(body.get("mode", "edit")),
            prompt=str(body.get("prompt", "")),
            steps=int(body.get("steps", 0)),
            seed=int(body.get("seed", -1)),
            lora_config=str(body.get("lora_config", "[]")),
        )
        _mark_latest_done(url, tool="edit", prompt=str(body.get("prompt", "")))
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


@app.post("/api/face-swap")
def api_face_swap(body: dict) -> dict:
    """Face swap: replace the head of `image` (base) with the face from
    `face` (Picture 2). An optional `prompt` is appended after the
    workflow's built-in head_swap instructions. The response carries the
    extracted-face preview too when the workflow produced one
    (``face_preview``: same shape as the main result). See tools/face_swap.py."""
    s = _settings()
    try:
        global _pending_tool, _pending_prompt
        _pending_tool = "face_swap"
        _pending_prompt = str(body.get("prompt", ""))
        cfg_raw = body.get("cfg")
        url, face_url = face_swap_image(
            s,
            image=str(body.get("image", "")),
            face=str(body.get("face", "")),
            prompt=_pending_prompt,
            steps=int(body.get("steps", 0)),
            cfg=float(cfg_raw) if cfg_raw not in (None, "") else None,
            seed=int(body.get("seed", -1)),
        )
        _mark_latest_done(url, tool="face_swap", prompt=_pending_prompt)
        resp = _tool_response(url)
        if face_url:
            resp["face_preview"] = _tool_response(face_url)
        return resp
    except Exception as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/upscale")
def api_upscale(body: dict) -> dict:
    s = _settings()
    try:
        global _pending_tool, _pending_prompt
        _pending_tool = "upscale"
        _pending_prompt = ""
        url = upscale_image(
            s,
            image=str(body.get("image", "")),
            seed=int(body.get("seed", -1)),
        )
        _mark_latest_done(url, tool="upscale")
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


@app.post("/api/video")
def api_video(body: dict) -> dict:
    s = _settings()
    try:
        global _pending_tool, _pending_prompt
        _pending_tool = "video"
        _pending_prompt = str(body.get("prompt", ""))
        url = generate_video(
            s,
            image=str(body.get("image", "")),
            model_version=str(body.get("model_version", "wan21")),
            prompt=str(body.get("prompt", "")),
            negative_prompt=str(body.get("negative_prompt", "")),
            frames=int(body.get("frames", 81)),
            steps=int(body.get("steps", 0)),
            seed=int(body.get("seed", -1)),
            lora_config=str(body.get("lora_config", "[]")),
            diffusion=str(body.get("diffusion", "")),
        )
        _mark_latest_done(url, tool="video", prompt=str(body.get("prompt", "")))
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)

# --------------------------------------------------------------------------- #
# Upload + media proxy + image validation
# --------------------------------------------------------------------------- #
@app.post("/api/check-image")
async def api_check_image(body: dict) -> dict:
    """Validate that a source value (external URL or ComfyUI temp filename)
    resolves to an image, by checking its Content-Type.

    The browser cannot read cross-origin headers, so the check runs here
    (server-side, no CORS). Returns ``{"ok": true, "content_type": ...}``
    or ``{"ok": false, "error": ...}`` — always 200 so the UI can
    distinguish "not an image" from a transport failure.
    """
    from urllib.parse import urlencode

    from tools._common import normalize_source

    s = _settings()
    value = str(body.get("url", "")).strip()
    if not value:
        return {"ok": False, "error": "No URL provided"}
    # Same filename-vs-URL auto-detection the tools use (configure_image_node):
    # external URL -> source="url" (use as-is); anything else -> a ComfyUI
    # temp filename (uploaded via 📁) -> media base /view?type=temp.
    value, kind = normalize_source(value)
    if kind == "url":
        url = value
    else:
        url = f"{s.media_base_url}/view?{urlencode({'filename': value, 'type': 'temp'})}"
    try:
        # GET with a stream: read only the headers + first bytes, never the body
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {resp.status_code}"}
                ctype = (resp.headers.get("content-type") or "").lower()
                # Magic-byte sniffing as a fallback: some servers serve images as
                # application/octet-stream with no useful Content-Type.
                head = b""
                async for chunk in resp.aiter_bytes(1024):
                    head += chunk
                    break
                is_image = ctype.startswith("image/") or _looks_like_image(head)
                if not is_image:
                    return {
                        "ok": False,
                        "error": f"Not an image (Content-Type: {ctype or 'unknown'})",
                    }
                return {"ok": True, "content_type": ctype}
    except Exception as e:
        return {"ok": False, "error": f"Could not reach the URL: {e}"}


def _looks_like_image(head: bytes) -> bool:
    """Sniff the file signature of the first bytes (PNG/JPEG/GIF/WebP/BMP/TIFF)."""
    if not head:
        return False
    if head.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")):
        return True
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return True
    if head.startswith(b"BM"):
        return True
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return True
    return False


# --------------------------------------------------------------------------- #
# Media existence check (for persisted galleries)
# --------------------------------------------------------------------------- #
@app.get("/api/media-exists")
def api_media_exists(filename: str, type: str = "output") -> dict:
    """Lightweight check that a result file still exists on the ComfyUI host.

    Used when restoring persisted galleries from localStorage: entries whose
    file has been deleted (ComfyUI can prune its output folder) must not be
    shown. Implemented as a HEAD to the upstream /view (no body transferred);
    some servers reject HEAD, so it falls back to a GET with
    ``Range: bytes=0-0`` (expects 206, transfers nothing). Never proxies the
    body — this is deliberately the cheapest possible probe.
    """
    from urllib.parse import urlencode

    s = _settings()
    url = f"{s.media_base_url}/view?{urlencode({'filename': filename, 'type': type})}"
    try:
        with httpx.Client(timeout=10) as client:
            # HEAD first (cheapest); if the server rejects it, GET with a
            # 0-byte Range (206 Partial Content, no body streamed).
            try:
                r = client.head(url, headers={"Accept": "*/*"})
                if r.status_code in (200, 206):
                    return {"exists": True, "status": r.status_code}
            except Exception:
                pass  # fall through to GET+Range
            try:
                r = client.get(url, headers={"Range": "bytes=0-0"})
                return {"exists": r.status_code in (200, 206), "status": r.status_code}
            except Exception:
                return {"exists": False, "error": "transport"}
    except Exception:
        return {"exists": False, "error": "transport"}


# --------------------------------------------------------------------------- #
# Upload + media proxy
# --------------------------------------------------------------------------- #
@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)) -> dict:
    s = _settings()
    data = await file.read()
    tmp = REPO / "tmp_uploads"
    tmp.mkdir(exist_ok=True)
    path = tmp / (file.filename or "upload.png")
    path.write_bytes(data)
    try:
        from comfy_client import ComfyClient

        with ComfyClient(settings=s) as c:
            filename = c.upload_image(path)
        return {"filename": filename}
    finally:
        path.unlink(missing_ok=True)


@app.get("/media/{filename}")
async def media(filename: str, type: str = "output", range: str | None = Header(default=None)) -> Response:
    """Same-origin proxy of ComfyUI results.

    Streams the body (no full-buffer) and honors HTTP Range headers — a
    <video> element issues range requests to seek/buffer progressively, and
    a full-buffer proxy (previous implementation) made videos unplayable
    until the whole file was downloaded (Wan MP4s are 20MB+, painful on
    vertical/mobile). Videos/images now start rendering while streaming.

    The upstream client must stay ALIVE until Starlette has streamed the
    whole body: the previous implementation returned the StreamingResponse
    inside ``async with httpx.AsyncClient(...)``/``client.stream(...)``
    blocks, which exited (closing the stream and the client) the moment the
    handler returned — BEFORE Starlette iterated ``aiter_bytes()`` — so the
    transfer died mid-body with ``httpx.StreamClosed`` (the browser showed
    NS_ERROR_NET_PARTIAL_NETWORK_TRANSFER even though the upstream served
    the file fully). The client is now created without a context manager and
    closed via BackgroundTask once the response finishes streaming.
    """
    s = _settings()
    url = f"{s.media_base_url}/view?filename={filename}&type={type}"
    headers = {"Range": range} if range else None
    client = httpx.AsyncClient(timeout=120)
    try:
        request = client.build_request("GET", url, headers=headers)
        resp = await client.send(request, stream=True)
    except Exception as e:
        await client.aclose()
        raise HTTPException(502, f"Could not fetch {url}: {e}") from e
    if resp.status_code >= 400:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(502, f"Could not fetch {url}: {resp.status_code}")
    ctype = resp.headers.get("content-type", "application/octet-stream")
    content_range = resp.headers.get("content-range")
    resp_headers = {"Cache-Control": "no-store", "Content-Type": ctype}
    if content_range:
        resp_headers["Content-Range"] = content_range
    if resp.headers.get("accept-ranges"):
        resp_headers["Accept-Ranges"] = resp.headers.get("accept-ranges")
    # Forward the upstream Content-Length so the browser gets a known-size
    # response (not chunked) — needed for <video> seeking/progress. When a
    # Range was requested and the upstream answered 206, this is the length
    # of the partial body (paired with Content-Range above).
    if resp.headers.get("content-length"):
        resp_headers["Content-Length"] = resp.headers["content-length"]
    return StreamingResponse(
        resp.aiter_bytes(),
        status_code=resp.status_code,  # 206 for ranges, 200 otherwise
        media_type=ctype,
        headers=resp_headers,
        background=BackgroundTask(client.aclose),  # close once streaming finishes
    )


# --------------------------------------------------------------------------- #
# Settings (for the 🎨 menu — B4 persists from here)
# --------------------------------------------------------------------------- #
@app.get("/api/settings")
def api_settings() -> dict:
    s = _settings()
    return {
        "comfyui_base_url": s.comfyui_base_url,
        "media_base_url": s.media_base_url,
        "has_api_key": bool(s.api_key),
        "prompt_refiner_base_url": s.prompt_refiner_base_url,
        "prompt_refiner_model": s.prompt_refiner_model,
        "prompt_refiner_system_prompt": s.prompt_refiner_system_prompt,
    }


@app.post("/api/settings")
def api_settings_update(body: dict) -> dict:
    """Persist global settings from the 🎨 dropdown (B4).

    Accepts any subset of {comfyui_base_url, comfyui_media_base_url,
    prompt_refiner_base_url, prompt_refiner_model,
    prompt_refiner_system_prompt}; empty strings
    clear the override (media falls back to the server URL; the refiner
    base URL empty disables the 🪄 refine button; an empty model selects
    the router's first model).
    """
    s = _settings()
    if "comfyui_base_url" in body:
        value = str(body["comfyui_base_url"]).strip()
        if not value:
            raise HTTPException(400, "comfyui_base_url must not be empty")
        s.set_base_url(value)
    if "comfyui_media_base_url" in body:
        s.set_media_base_url(str(body["comfyui_media_base_url"]).strip())
    if "prompt_refiner_base_url" in body:
        s.set_refiner_base_url(str(body["prompt_refiner_base_url"]).strip())
    if "prompt_refiner_model" in body:
        s.set_refiner_model(str(body["prompt_refiner_model"]).strip())
    if "prompt_refiner_system_prompt" in body:
        s.set_refiner_system_prompt(str(body["prompt_refiner_system_prompt"]))
    return {
        "comfyui_base_url": s.comfyui_base_url,
        "media_base_url": s.media_base_url,
        "has_api_key": bool(s.api_key),
        "prompt_refiner_base_url": s.prompt_refiner_base_url,
        "prompt_refiner_model": s.prompt_refiner_model,
        "prompt_refiner_system_prompt": s.prompt_refiner_system_prompt,
    }


@app.get("/api/refiner-models")
def api_refiner_models() -> dict:
    """Model ids served by the llama.cpp router (GET /v1/models proxy).

    Returns ``{"models": [...], "default": "first id"}`` where default
    is what the refiner uses when the model setting is empty (the first
    model NOT flagged in REFINER_EXCLUDE). ``models`` is [] when the
    refiner is not configured; other failures bubble as a 400.
    """
    from prompt_refiner import RefinerError, RefinerUnavailable, list_models, resolve_model

    s = _settings()
    try:
        models = list_models(s)
        default = resolve_model(s) if models else ""
    except RefinerUnavailable:
        return {"models": [], "default": ""}
    except RefinerError as e:
        raise HTTPException(400, str(e)) from e
    return {"models": models, "default": default}


@app.post("/api/refine-prompt")
def api_refine_prompt(body: dict):
    """Refine a prompt via the llama-server refiner (OpenAI-compatible).

    Body: ``{"prompt": "...", "system_prompt": "..."?, "stream": bool?}``.
    With ``stream`` true it returns a Server-Sent-Events stream of the
    refined prompt deltas (``data: {\"delta\": \"...\"}``) so the UI can
    show the refinement evolving live and cancel mid-stream; otherwise it
    returns ``{"refined": "..."}``. Failures are a 400 with a user-facing
    message.
    """
    from prompt_refiner import RefinerError, RefinerUnavailable, refine_prompt, stream_refine_prompt

    s = _settings()
    prompt = str(body.get("prompt", ""))
    system_prompt = body.get("system_prompt")
    if body.get("stream"):
        try:
            gen = stream_refine_prompt(s, prompt, system_prompt)
        except (RefinerUnavailable, RefinerError) as e:
            raise HTTPException(400, str(e)) from e
        return StreamingResponse(_refine_event_stream(gen), media_type="text/event-stream")
    try:
        refined = refine_prompt(s, prompt, system_prompt)
    except RefinerUnavailable as e:
        raise HTTPException(400, str(e)) from e
    except RefinerError as e:
        raise HTTPException(400, str(e)) from e
    return {"refined": refined}


def _refine_event_stream(gen):
    """Yield an SSE event stream from a refine delta generator.

    Each delta/meta item becomes a ``data: {...}`` event; a final
    ``{"done": true}`` closes the stream; a RefinerError mid-stream
    becomes a ``{"error": ...}`` event. GeneratorExit (client disconnect /
    cancel) closes the underlying llama stream.
    """
    try:
        for item in gen:
            if isinstance(item, dict) and "delta" in item:
                yield f"data: {json.dumps({'delta': item['delta']})}\n\n"
            elif isinstance(item, dict) and "meta" in item:
                yield f"data: {json.dumps({'meta': item['meta']})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"
    except RefinerError as e:
        yield f"data: {json.dumps({'error': str(e)[:300]})}\n\n"
    except GeneratorExit:
        gen.close()  # client disconnected / cancelled — close llama stream
        raise


