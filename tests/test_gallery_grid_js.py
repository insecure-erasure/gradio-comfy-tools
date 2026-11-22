"""Thumbnail grid of the fullscreen gallery (counter button).

Covers the pure sizing geometry (node unit tests), the markup, the CSS
contract and the wiring in gallery.js.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE_TEST = ROOT / "tests" / "js" / "gallery_grid_test.js"


def _read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required for the JS unit tests")
def test_gallery_grid_unit_tests():
    proc = subprocess.run(
        ["node", str(NODE_TEST)], capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, "\n" + proc.stdout + proc.stderr


def test_grid_metrics_load_before_gallery_js():
    html = _read("templates", "index.html")
    assert "/static/js/gallery-grid.js" in html
    assert html.index("/static/js/gallery-grid.js") < html.index("/static/js/gallery.js")


def test_counter_is_the_grid_toggle_and_the_sheet_exists():
    overlay = _read("templates", "partials", "gallery_overlay.html")
    assert 'id="galleryCounter"' in overlay
    # The counter became a BUTTON with the grid relationship.
    assert '<button class="gallery-counter"' in overlay
    assert 'aria-controls="galleryGrid"' in overlay
    assert 'aria-expanded="false"' in overlay
    assert 'id="galleryCounterText"' in overlay      # N/M repaints alone
    # Decision: the counter is plain text, no glyph/icon.
    assert "gallery-counter-glyph" not in overlay
    assert "▦" not in overlay
    assert 'id="galleryGrid"' in overlay
    assert 'id="galleryGridThumbs"' in overlay
    assert 'id="galleryGridTitle"' in overlay


def test_css_uses_cover_cells_and_hides_the_individual_controls():
    css = _read("static", "css", "components.css")
    assert ".gallery-grid {" in css
    assert ".gallery-grid-thumbs {" in css
    assert ".gallery-thumb {" in css
    # Decision: uniform cells filled by the image (corners cropped).
    assert "object-fit: cover;" in css
    assert "gallery-counter-glyph" not in css
    assert ".gallery-thumb.is-video" in css
    assert ".gallery-thumb-index" in css
    # While the sheet is open the individual-view buttons would act behind it.
    assert ".gallery-overlay.grid-open .gallery-prev" in css
    assert ".gallery-overlay.grid-open .gallery-info" in css


def test_gallery_js_wiring():
    gallery = _read("static", "js", "gallery.js")
    for symbol in (
        "function openGalleryGrid(fromPane)",
        "function closeGalleryGrid(restoreFocus = true)",
        "function toggleGalleryGrid()",
        "function renderGalleryGrid()",
        "function galleryGridSelect(i)",
        "function syncGalleryGrid()",
        "function refitGalleryGrid()",
    ):
        assert symbol in gallery, symbol
    # Counter click toggles; backdrop click inside the sheet closes just it.
    assert "galleryCounter.addEventListener('click'" in gallery
    assert "toggleGalleryGrid();" in gallery
    assert "galleryGrid.addEventListener('click'" in gallery
    # Selecting a thumb closes the sheet; from the in-gallery counter it shows
    # the individual fullscreen view (from a pane it returns to the pane, see
    # tests/test_pane_actions_js.py).
    assert "closeGalleryGrid();" in gallery
    assert "resetGalleryZoom();\n  renderGalleryItem();" in gallery
    # The sheet never survives the overlay, and never opens with it.
    assert "closeGalleryGrid(false); // the sheet never survives the overlay" in gallery
    assert "closeGalleryGrid(false); // always open on the individual view" in gallery
    # Video tiles do not instantiate <video> (no decoding of N MP4s).
    assert "galleryMode === 'video'" in gallery
    assert "gallery-thumb-play" in gallery
    # Mobile URL bar changes the visible box.
    assert "window.visualViewport.addEventListener('resize', refitGalleryGrid)" in gallery
    # A pure navigation updates the ring instead of rebuilding the thumbnails.
    assert "_galleryGridSignature" in gallery
    assert "syncGalleryGridActive();" in gallery
    # Thumbnails are NOT preloaded: the <img> starts without src and the
    # IntersectionObserver assigns it near the view, with bounded concurrency.
    assert "const GALLERY_GRID_CONCURRENCY = 6;" in gallery
    assert "new IntersectionObserver(" in gallery
    assert "root: galleryGridThumbs" in gallery
    assert "rootMargin: '240px 0px'" in gallery
    assert "_requestGridThumb(tile, rec.img, rec.url)" in gallery
    assert "img.src = url;" in gallery
    assert "img.src = e.src" not in gallery
    # Resizing only re-lays out (no rebuild → no reload, scroll survives).
    assert "function layoutGalleryGrid()" in gallery
    assert "function refitGalleryGrid() {\n  if (!galleryGridOpen) return;\n  layoutGalleryGrid();" in gallery
    # Closing frees the observer/queue and the tiles.
    assert "_resetGridLoader();" in gallery


def test_keyboard_behaviour_in_the_sheet():
    gallery = _read("static", "js", "gallery.js")
    assert "if (galleryGridOpen) {" in gallery
    # Escape closes the sheet, not the gallery; Enter/Space opens the FOCUSED
    # tile (falling back to the sheet selection).
    assert "if (e.key === 'Escape') { e.preventDefault(); closeGalleryGrid(); return; }" in gallery
    assert "function _gridThumbIndexFromTarget(target)" in gallery
    assert "const focused = _gridThumbIndexFromTarget(target);" in gallery
    assert "galleryGridSelect(focused >= 0 ? focused : galleryGridIdx);" in gallery
    # Arrows move the SHEET selection; the individual view (galleryIdx) is only
    # committed by galleryGridSelect().
    assert "galleryGridIdx = Math.max(0, Math.min(galleryEntries.length - 1, galleryGridIdx + step));" in gallery
    assert ": e.key === 'ArrowUp' ? -galleryGridCols" in gallery
    assert ": e.key === 'ArrowDown' ? galleryGridCols" in gallery
    # No badges on the thumbs (decision) and no shortcut for the sheet.
    assert "gallery-thumb-badge" not in gallery
    assert "galleryGridBadge" not in gallery


def test_sheet_selection_does_not_touch_the_individual_view():
    gallery = _read("static", "js", "gallery.js")
    # A dedicated selection index, initialised from the shown entry.
    assert "let galleryGridIdx = -1;" in gallery
    assert "galleryGridIdx = galleryIdx;" in gallery
    assert "galleryIdx = i;\n  galleryGridIdx = i;" in gallery
    # The ring, title and counter follow the sheet selection.
    assert "Number(tile.dataset.index) === galleryGridIdx" in gallery
    assert "const idx = galleryGridIdx >= 0 ? galleryGridIdx : galleryIdx;" in gallery
    assert "_paintGalleryCounter(galleryGridIdx);" in gallery
    # Closing without picking drops the sheet selection and restores the
    # individual view's counter.
    assert "galleryGridIdx = -1; // closing without picking discards the sheet selection" in gallery
    assert "_paintGalleryCounter(galleryIdx); // and restores the individual view's N/M" in gallery
    # Opening moves the focus into the sheet; cancelling returns it to the
    # visible counter.
    assert "active.focus({ preventScroll: true });" in gallery
    assert "galleryCounter.focus({ preventScroll: true });" in gallery


def test_native_fullscreen_exit_runs_the_full_close():
    gallery = _read("static", "js", "gallery.js")
    # Both the explicit close and the browser fullscreen exit share one helper.
    assert "function _finalizeGalleryClose()" in gallery
    assert "_finalizeGalleryClose();" in gallery
    assert "let _galleryClosePending = false;" in gallery
    # Escape in native fullscreen never reaches keydown: the fullscreenchange
    # path must close the sheet, apply the picked entry and clear the flags.
    assert "const wasOpen = galleryOverlay.classList.contains('show') || _galleryClosePending;" in gallery
    assert "if (_galleryClosePending) {" in gallery
    assert "closeGalleryGrid(false); // the sheet never survives the overlay" in gallery
    assert "const repaintTab = _paneRepaintOnClose;" in gallery
    assert "renderPane(repaintTab);" in gallery

def test_video_thumbs_use_the_source_image_as_poster():
    video = _read("static", "js", "video.js")
    gallery = _read("static", "js", "gallery.js")
    css = _read("static", "css", "components.css")
    # The entry stores the SOURCE image the video was generated from.
    assert "addGeneratedVideo(res, prompt, typeof beforeProxyUrl === 'function'" in video
    assert "function addGeneratedVideo(result, prompt, source)" in gallery
    assert "source: source || ''," in gallery
    # storage.js normalizes video entries with a WHITELIST of fields: it must
    # keep `source` or the poster disappears on every reload.
    storage = _read("static", "js", "storage.js")
    assert "source: typeof e.source === 'string' ? e.source : ''," in storage
    # The sheet shows it through the same lazy loader, with a ▶ badge on top.
    assert "tile._gridThumb = { img, url: e.source };" in gallery
    assert "galleryMode === 'video' && e.source" in gallery
    assert "poster.addEventListener('error', () => { poster.remove(); });" in gallery
    # A failed poster is removed (not dimmed), and the ▶ stays visible.
    assert "if (!ok && img.isConnected) tile.classList.add('broken');" in gallery
    # Overlay badge (no longer a flex child of a plain tile).
    block = css[css.index(".gallery-thumb-play {"):]
    block = block[: block.index("}")]
    assert "position: absolute;" in block
    assert "translate(-50%, -50%)" in block
    assert "pointer-events: none;" in block
