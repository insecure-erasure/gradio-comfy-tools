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
MAIN = (ROOT / "static" / "js" / "main.js").read_text(encoding="utf-8")
RESTORE = (ROOT / "static" / "js" / "restore.js").read_text(encoding="utf-8")


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


def test_delete_key_removes_the_generation_shown_in_the_pane():
    assert "if (e.key !== 'Delete') return;" in MAIN
    assert "if (e.defaultPrevented) return;" in MAIN
    assert "paneDeleteCurrent()" in MAIN
    body = _function_body(GALLERY, "function paneDeleteCurrent()")
    assert "forgetSourceHistoryEntry(e)" in body
    assert "removeGalleryEntryFromRegistry(e, mode)" in body
    assert "clearPaneResult(tab)" in body
    assert "renderPane(tab)" in body


def test_delete_key_removes_the_fullscreen_gallery_entry():
    start = GALLERY.index("// Keyboard: Escape closes")
    body = GALLERY[start:GALLERY.index("\n});", start)]
    assert "e.key === 'Delete'" in body
    assert "galleryDeleteCurrent()" in body
    assert "e.preventDefault()" in body


def test_toolbar_trash_uses_the_same_empty_pane_helper():
    body = _function_body(RESTORE, "function clearTabGallery(tab)")
    assert "clearPaneResult(tab)" in body
