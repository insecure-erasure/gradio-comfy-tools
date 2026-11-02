"""Regression guards for gallery registration on the recovery paths.

Normal generation finalizers register their result, but a job adopted after
a reload is finalized by ``finalizeRecoveredJob``. The galleries restored
from localStorage were written BEFORE that job finished, so the new result
must be registered there explicitly — for EVERY tool, not only video.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "static" / "js"
API = (JS / "api.js").read_text(encoding="utf-8")
VIDEO = (JS / "video.js").read_text(encoding="utf-8")
EDIT = (JS / "edit.js").read_text(encoding="utf-8")
UPSCALE = (JS / "upscale.js").read_text(encoding="utf-8")
FACE_SWAP = (JS / "face_swap.js").read_text(encoding="utf-8")


def _function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start)
    return source[start:end]


def test_video_finalizer_registers_the_generated_video():
    body = _function_body(VIDEO, "function finalizeVideo(res)")
    assert "addGeneratedVideo(res, prompt)" in body


def test_reload_adoption_registers_new_results_in_every_gallery():
    body = _function_body(API, "function finalizeRecoveredJob(tool, res, marker)")
    assert "addGeneratedVideo(res, prompt)" in body
    assert "addGeneratedEntry(res, prompt)" in body
    assert "addCompareEntry(compareEntry)" in body
    assert "appendTransformedEntry(res, prompt, badge, source)" in body
    assert "addTransformedEntry(res, '', 'upscaled', source)" in body
    assert "addFaceSwapEntry(res, before, prompt)" in body
    # The pane must show the compare slider again, not a plain result image.
    assert "restoreCompareSlider(tool, paneId, compareEntry)" in body


def test_job_marker_carries_the_context_for_the_recovered_entry():
    body = _function_body(API, "function persistJobMarker(tool, meta)")
    assert "prompt," in body
    for key in ("'mode'", "'source'", "'base'", "'face'"):
        assert key in body
    assert "persistJobMarker(liveJobTab, meta)" in API
    assert "finalizeRecoveredJob(marker.tool, res, marker)" in API


def test_tools_pass_their_recovery_context():
    assert "startProgressPolling({ mode, source: src })" in EDIT
    assert "startProgressPolling({ source: src })" in UPSCALE
    assert "startProgressPolling({ base, face })" in FACE_SWAP


def test_a_job_that_settled_while_away_is_also_recovered():
    assert "recoveredResultFromLast(last)" in API
    assert "if (res) finalizeRecoveredJob(marker.tool, res, marker)" in API
