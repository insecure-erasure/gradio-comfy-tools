"""Regression guards for gallery registration on the recovery paths.

Normal generation finalizers register their result, but a job adopted after
a reload is finalized by ``finalizeRecoveredJob``. The galleries restored
from localStorage were written BEFORE that job finished, so the new result
must be registered there explicitly — otherwise the pane shows the video (or
image) while the fullscreen gallery still does not contain it.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = (ROOT / "static" / "js" / "api.js").read_text(encoding="utf-8")
VIDEO = (ROOT / "static" / "js" / "video.js").read_text(encoding="utf-8")


def _function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start)
    return source[start:end]


def test_video_finalizer_registers_the_generated_video():
    body = _function_body(VIDEO, "function finalizeVideo(res)")
    assert "addGeneratedVideo(res, prompt)" in body


def test_reload_adoption_registers_new_results_in_the_gallery():
    body = _function_body(API, "function finalizeRecoveredJob(tool, res, marker)")
    assert "addGeneratedVideo(res, prompt)" in body
    assert "addGeneratedEntry(res, prompt)" in body


def test_job_marker_carries_the_prompt_for_the_recovered_entry():
    body = _function_body(API, "function persistJobMarker(tool, prompt)")
    assert "prompt:" in body
    assert "persistJobMarker(liveJobTab, jobPrompt)" in API
    assert "finalizeRecoveredJob(marker.tool, res, marker)" in API
