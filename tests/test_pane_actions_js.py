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
        # Bottom corners, mirroring the fullscreen gallery (not the ℹ️ stack).
        assert 'class="output-overlay-btn pane-delete-btn"' in body, partial
        assert 'class="output-overlay-btn pane-grid-btn"' in body, partial
        # The button is the pane's gallery counter: N/M text, no icon.
        assert 'aria-label="Thumbnails">0/0</button>' in body, partial


def test_css_positions_and_hides_them_while_generating():
    css = _read("static", "css", "components.css")
    # 🗑️ owns the bottom-left corner; the counter is the RIGHTMOST button of
    # the source cluster row (bottom 48), which slides left to make room.
    assert ".output-overlay-btn.pane-delete-btn { bottom: 12px; left: 12px; }" in css
    assert ".output-overlay-btn.pane-grid-btn { bottom: 12px; right: 12px; }" in css
    # The source field/cluster moved up one row (36px) to make room.
    assert ".source-url-field {\n    position: absolute;\n    /* Raised one row (36px)" in css
    # The cluster keeps its row (bottom 12) and only slides left for the pill.
    # The pill hugs its digits; the cluster is offset from the MEASURED width
    # so the 6px gap matches the other buttons: 12 + w + 6, then +36 per slot.
    assert "width: auto;\n    min-width: 38px;\n    padding: 0 8px;" in css
    assert ".output-overlay-btn.bottom-right { bottom: 12px; right: calc(18px + var(--pane-counter-w, 44px)); }" in css
    assert ".output-overlay-btn.bottom-right-left { bottom: 12px; right: calc(54px + var(--pane-counter-w, 44px)); }" in css
    assert ".output-overlay-btn.bottom-right-left2 { bottom: 12px; right: calc(90px + var(--pane-counter-w, 44px)); }" in css
    assert ".output-overlay-btn.bottom-right-left3 { bottom: 12px; right: calc(126px + var(--pane-counter-w, 44px)); }" in css
    assert "bottom: 88px;   /* one row above the face field (48px) */" in css
    # Nothing left on top of the ℹ️ column.
    assert "top-left-2" not in css
    assert "top-left-3" not in css
    # During a generation ℹ️ hides (the pane shows the live preview) but 🗑️
    # and the N/M counter stay visible like the other overlay buttons.
    assert ".output-pane.generating .pane-info-btn { display: none !important; }" in css
    assert ".output-pane.generating .pane-delete-btn" not in css
    assert ".output-pane.generating .pane-grid-btn" not in css
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
    # The measured pill width drives the cluster offset (uniform 6px gap).
    assert "pane.style.setProperty('--pane-counter-w', w + 'px');" in gallery
    assert "btn.getBoundingClientRect().width" in gallery
    assert "showToast('Nothing to delete')" in gallery
    # Both pane actions refuse while a job runs (same message as the locks).
    assert "function paneActionBlocked()" in gallery
    assert "showToast('Generation in progress…');" in gallery
    assert "if (paneActionBlocked()) return;" in gallery
    assert "if (paneActionBlocked()) return;\n  if (!paneGalleryCount(tab)) {" in gallery
    assert "async function openPaneGrid(tab)" in gallery
    assert "showToast('Nothing to show yet')" in gallery
    # The sheet knows where it came from and KEEPS it across close/reopen
    # (the counter is also the toggle).
    assert "let _paneGridTab = null;" in gallery
    assert "function openGalleryGrid(fromPane)" in gallery
    assert "_paneGridTab = fromPane || null;" in gallery
    assert "function toggleGalleryGrid() {\n  // Keep the pane origin across a close/reopen of the sheet.\n  if (galleryGridOpen) closeGalleryGrid();\n  else openGalleryGrid(_paneGridTab);\n}" in gallery


def test_toggling_the_sheet_keeps_the_pane_origin():
    gallery = _read("static", "js", "gallery.js")
    # closeGalleryGrid() leaves _paneGridTab intact; reopening passes it back so
    # a thumb picked after toggling still returns to the pane.
    assert "else openGalleryGrid(_paneGridTab);" in gallery
    assert "_paneGridTab = null; // a closed gallery never keeps the pane origin" in gallery


def test_pane_sheet_does_not_wait_for_the_full_verification():
    gallery = _read("static", "js", "gallery.js")
    # The pane ▦ path opens the sheet immediately; the openers receive
    # verify=false instead of awaiting verifyStoredGalleries(true).
    assert "openGenerateLightbox(undefined, { verify: false })" in gallery
    assert "openFaceSwapGallery({ verify: false })" in gallery
    assert "openCompareFullscreen(tab, { verify: false })" in gallery
    # The fullscreen buttons keep the blocking verification as the default.
    assert "async function openGenerateLightbox(img, { verify = true } = {})" in gallery
    assert "async function openFaceSwapGallery({ verify = true } = {})" in gallery
    assert "async function openCompareFullscreen(kind, { verify = true } = {})" in gallery
    # The probe starts AFTER the sheet is visible and is never awaited.
    assert "openGalleryGrid(tab);\n  // The sheet is already visible" in gallery
    assert "if (tab !== 'video') _verifyGalleriesInBackground();" in gallery
    assert "await _verifyGalleriesInBackground" not in gallery
    # Rapid reopenings share one background probe.
    assert "function _verifyGalleriesInBackground()" in gallery
    assert "if (_galleryVerifyPromise) return;" in gallery


def test_picking_from_the_pane_sheet_returns_to_the_pane():
    gallery = _read("static", "js", "gallery.js")
    assert "function paneEntriesFor(tab)" in gallery
    # Selection sets the pane index, closes the overlay and paints the pane.
    assert "paneIdx[fromPane] = idx >= 0 ? idx : -1;" in gallery
    assert "closeGallery(); // clears _paneGridTab and restores the pane" in gallery
    assert "if (idx >= 0) renderPane(fromPane);" in gallery
    assert "syncPaneNav(fromPane);" in gallery
    # Focus returns to the pane the pick landed in.
    assert "const pane = document.getElementById(paneId);" in gallery
    assert "pane.focus({ preventScroll: true });" in gallery
    # Compare entries are matched by reference OR url/filename (collected copy).
    assert "absUrl(x.src) === absUrl(chosen.src)" in gallery
    assert "x.filename === chosen.filename" in gallery

def test_fullscreen_pick_updates_the_pane_after_closing():
    gallery = _read("static", "js", "gallery.js")
    # The overlay knows which tab's gallery it is showing.
    assert "let _galleryTab = null;" in gallery
    assert "_galleryTab = 'generate';" in gallery
    assert "_galleryTab = 'face_swap';" in gallery
    assert "_galleryTab = tab;" in gallery
    assert "_galleryTab = 'video';" in gallery
    # A thumb PICKED (not ‹ › navigation) marks the pane to repaint on close.
    assert "let _paneRepaintOnClose = null;" in gallery
    assert "function paneIndexOfEntry(tab, chosen)" in gallery
    assert "_paneRepaintOnClose = tab;" in gallery
    assert "paneIdx[tab] = idx;" in gallery
    # Closing the overlay repaints the pane with the picked entry.
    assert "const repaintTab = _paneRepaintOnClose;" in gallery
    assert "renderPane(repaintTab);" in gallery
    # Opening never inherits a stale pick.
    assert "_paneRepaintOnClose = null;" in gallery
