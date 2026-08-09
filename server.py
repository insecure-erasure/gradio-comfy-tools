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

Run:  .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import base64
import json
import struct
import threading
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

import comfy_client
from config import Settings
from tools.edit import edit_image, MODES
from tools.generate import FAMILY_OPTIONS, generate_image
from tools.upscale import upscale_image
from tools.video import MODEL_VERSIONS, generate_video

REPO = Path(__file__).resolve().parent

# Modular frontend: mockup.html stays as the design template/spec, the
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


def _settings() -> Settings:
    return Settings()


def _filename_from_url(url: str) -> tuple[str, str]:
    """(filename, type) parsed from a ComfyUI result URL."""
    query = url.rsplit("?", 1)[-1]
    parts = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
    return parts.get("filename", ""), parts.get("type", "output")


# --------------------------------------------------------------------------- #
# Live progress (B5-lite)
#
# Every queue_prompt fires a hook (see comfy_client.register_prompt_hook) that
# spawns a daemon thread: it opens a WebSocket to ComfyUI with the SAME
# clientId used for POST /prompt, follows that prompt's events (executing /
# progress / executed / execution_success) and updates an in-memory job store.
# GET /api/progress exposes the most recent active job; the frontend polls it
# while a generation runs and paints the stage into the result URL row.
# --------------------------------------------------------------------------- #
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_MAX_JOBS = 20


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
                        break
                    elif t == "execution_error":
                        job["done"] = True
                        job["error"] = str(data.get("exception_message", "execution error"))[:300]
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
        }
    threading.Thread(
        target=_listen_job_ws,
        args=(base, client_id, prompt_id, _node_titles(workflow)),
        daemon=True,
    ).start()


def _mark_job_result(prompt_id: str, url: str) -> None:
    """Mark a job done and attach its result URL.

    The per-step preview is dropped here (and on cancel, where url=None):
    previews are ephemeral — once the real result is ready (or the job was
    cancelled) keeping them would only hold memory.
    """
    with _jobs_lock:
        job = _jobs.get(prompt_id)
        if job is not None:
            job["done"] = True
            job["url"] = url
            job.pop("preview", None)


def _latest_job() -> dict | None:
    with _jobs_lock:
        if not _jobs:
            return None
        return max(_jobs.values(), key=lambda j: j.get("started", 0))


def _mark_latest_done(url: str) -> None:
    """Attach the result URL to the most recent job (single-user app)."""
    job = _latest_job()
    if job is not None:
        _mark_job_result(job["prompt_id"], url)


def _on_prompt_queued(client_id: str, prompt_id: str, workflow: dict) -> None:
    _start_job_listener(client_id, prompt_id, workflow)


comfy_client.register_prompt_hook(_on_prompt_queued)


# --------------------------------------------------------------------------- #
# UI + health
# --------------------------------------------------------------------------- #
@app.get("/")
def index(request: Request) -> Response:
    return TEMPLATES.TemplateResponse(request, "index.html")


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
    """
    job = _latest_job()
    if job is None or job.get("done"):
        return {"active": None}
    active = {
        k: job.get(k)
        for k in ("prompt_id", "stage", "node", "node_title", "value", "max")
    }
    pv = job.get("preview")
    if pv:
        active["preview"] = "data:image/jpeg;base64," + base64.b64encode(pv).decode("ascii")
    return {"active": active}


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
        _mark_latest_done(url)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


@app.post("/api/edit")
def api_edit(body: dict) -> dict:
    s = _settings()
    try:
        url = edit_image(
            s,
            image=str(body.get("image", "")),
            mode=str(body.get("mode", "edit")),
            prompt=str(body.get("prompt", "")),
            steps=int(body.get("steps", 0)),
            seed=int(body.get("seed", -1)),
            lora_config=str(body.get("lora_config", "[]")),
        )
        _mark_latest_done(url)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


@app.post("/api/upscale")
def api_upscale(body: dict) -> dict:
    s = _settings()
    try:
        url = upscale_image(
            s,
            image=str(body.get("image", "")),
            seed=int(body.get("seed", -1)),
        )
        _mark_latest_done(url)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


@app.post("/api/video")
def api_video(body: dict) -> dict:
    s = _settings()
    try:
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
        _mark_latest_done(url)
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
        "prompt_refiner_system_prompt": s.prompt_refiner_system_prompt,
    }


@app.post("/api/settings")
def api_settings_update(body: dict) -> dict:
    """Persist global settings from the 🎨 dropdown (B4).

    Accepts any subset of {comfyui_base_url, comfyui_media_base_url,
    prompt_refiner_base_url, prompt_refiner_system_prompt}; empty strings
    clear the override (media falls back to the server URL; the refiner
    base URL empty disables the 🪄 refine button).
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
    if "prompt_refiner_system_prompt" in body:
        s.set_refiner_system_prompt(str(body["prompt_refiner_system_prompt"]))
    return {
        "comfyui_base_url": s.comfyui_base_url,
        "media_base_url": s.media_base_url,
        "has_api_key": bool(s.api_key),
        "prompt_refiner_base_url": s.prompt_refiner_base_url,
        "prompt_refiner_system_prompt": s.prompt_refiner_system_prompt,
    }


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

        def event_stream():
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

        return StreamingResponse(event_stream(), media_type="text/event-stream")
    try:
        refined = refine_prompt(s, prompt, system_prompt)
    except RefinerUnavailable as e:
        raise HTTPException(400, str(e)) from e
    except RefinerError as e:
        raise HTTPException(400, str(e)) from e
    return {"refined": refined}
