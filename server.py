"""Backend API server — serves mockup.html as the real frontend.

The mockup (source of truth for the UI) is served at `/`; its JS actions call
these endpoints, which run the validated tools in `tools/`. Images/videos are
proxied through `/media/...` so the browser never talks to the ComfyUI host
directly (no CORS/host validation issues).

Endpoints:
    GET  /                        mockup.html (the UI)
    GET  /health                  server + ComfyUI health
    POST /api/generate            Generate tab
    POST /api/edit                Edit tab
    POST /api/upscale             Upscale tab
    POST /api/video               Video tab
    POST /api/upload              upload an image to ComfyUI (temp)
    GET  /media/{filename}?type=  proxy a result file from ComfyUI
    GET  /api/settings            current global settings (for the 🎨 menu)

Run:  .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

from pathlib import Path

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from config import Settings
from tools.edit import edit_image, MODES
from tools.generate import FAMILY_OPTIONS, generate_image
from tools.upscale import upscale_image
from tools.video import MODEL_VERSIONS, generate_video

REPO = Path(__file__).resolve().parent

# The real page is app.html — a working copy of the mockup (which stays as
# the design template/spec and is never edited for functionality).
PAGE_FILE = REPO / "app.html"

app = FastAPI(title="Comfy Tools")


def _settings() -> Settings:
    return Settings()


def _filename_from_url(url: str) -> tuple[str, str]:
    """(filename, type) parsed from a ComfyUI result URL."""
    query = url.rsplit("?", 1)[-1]
    parts = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
    return parts.get("filename", ""), parts.get("type", "output")


# --------------------------------------------------------------------------- #
# UI + health
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(PAGE_FILE)


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
        )
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
        )
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return _tool_response(url)


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
async def media(filename: str, type: str = "output") -> Response:
    s = _settings()
    url = f"{s.media_base_url}/view?filename={filename}&type={type}"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(502, f"Could not fetch {url}: {e}") from e
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "application/octet-stream"),
        headers={"Cache-Control": "no-store"},
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
    }
