"""Regression guard for deleting a gallery entry from the fullscreen overlay.

Generated results are automatically remembered in the 🕘 source history.
Deleting one entry from a gallery must therefore also remove it from that
history (and repaint an open popover), not only from the fullscreen registry.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GALLERY = (ROOT / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
SOURCE = (ROOT / "static" / "js" / "source.js").read_text(encoding="utf-8")


def _function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start)
    return source[start:end]


def test_gallery_delete_forgets_the_image_in_source_history():
    body = _function_body(GALLERY, "function galleryDeleteCurrent()")
    assert "forgetSourceHistoryEntry(e)" in body


def test_source_history_forget_repaints_an_open_popover():
    body = _function_body(SOURCE, "function forgetSourceHistoryEntry(entry)")
    assert "mediaDropPlan(" in body
    assert "renderSourceHistoryGrid(_sourceHistoryTab)" in body
