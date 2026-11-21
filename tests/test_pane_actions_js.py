"""Pane action buttons: 🗑️ delete the shown result and ▦ the thumbnail picker.

Coherence with the fullscreen gallery: the pane exposes the same actions, and
a thumb picked from the pane's sheet lands IN THE PANE (not in the fullscreen
individual view).
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PANE_TABS = (
    ("tab_generate.html", "generate"),
    ("tab_edit.html", "edit"),
    ("tab_face_swap.html", "face_swap"),
    ("tab_upscale.html", "upscale"),
    ("tab_video.html", "video"),
)


def _read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


def test_every_pane_has_delete_and_grid_buttons():
    for partial, _tab in PANE_TABS:
        body = _read("templates", "partials", partial)
        assert "pane-delete-btn" in body, partial
        assert "paneDeleteShown()" in body, partial
        assert "pane-grid-btn" in body, partial
        assert "openPaneGrid()" in body, partial
        # Stacked under the ℹ️ button of the same pane.
        assert "top-left-2 pane-delete-btn" in body, partial
        assert "top-left-3 pane-grid-btn" in body, partial
        # The button is the pane's gallery counter: N/M text, no icon.
        assert 'aria-label="Thumbnails">0/0</button>' in body, partial


def test_css_positions_and_hides_them_while_generating():
    css = _read("static", "css", "components.css")
    assert ".output-overlay-btn.top-left-2 { top: 48px; left: 12px; }" in css
    assert ".output-overlay-btn.top-left-3 { top: 84px; left: 12px; }" in css
    assert ".output-pane.generating .pane-delete-btn" in css
    assert ".output-pane.generating .pane-grid-btn" in css
    # Text pill (N/M), not the square icon shape.
    assert ".output-overlay-btn.pane-grid-btn {" in css
    assert "font-variant-numeric: tabular-nums;" in css


def test_pane_actions_are_wired():
    gallery = _read("static", "js", "gallery.js")
    assert "function paneDeleteShown()" in gallery
    # The pane button displays the gallery position as N/M.
    assert "function paneCounterText(tab)" in gallery
    assert "function syncPaneCount(tab)" in gallery
    assert "syncPaneCount(tab);" in gallery
    assert "btn.textContent = paneCounterText(tab);" in gallery
    assert "showToast('Nothing to delete')" in gallery
    assert "async function openPaneGrid(tab)" in gallery
    assert "showToast('Nothing to show yet')" in gallery
    # The sheet knows where it came from.
    assert "let _paneGridTab = null;" in gallery
    assert "function openGalleryGrid(fromPane)" in gallery
    assert "_paneGridTab = fromPane || null;" in gallery
    # The in-gallery counter keeps the fullscreen behaviour (no pane origin).
    assert "function toggleGalleryGrid() {\n  if (galleryGridOpen) closeGalleryGrid();\n  else openGalleryGrid();" in gallery


def test_picking_from_the_pane_sheet_returns_to_the_pane():
    gallery = _read("static", "js", "gallery.js")
    assert "function paneEntriesFor(tab)" in gallery
    # Selection sets the pane index, closes the overlay and paints the pane.
    assert "paneIdx[fromPane] = idx >= 0 ? idx : -1;" in gallery
    assert "closeGallery(); // clears _paneGridTab and restores the pane" in gallery
    assert "if (idx >= 0) renderPane(fromPane);" in gallery
    assert "syncPaneNav(fromPane);" in gallery
    # Compare entries are matched by reference OR url/filename (collected copy).
    assert "absUrl(x.src) === absUrl(chosen.src)" in gallery
    assert "x.filename === chosen.filename" in gallery
