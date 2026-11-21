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
        "function closeGalleryGrid()",
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
    assert "closeGalleryGrid(); // the sheet never survives the overlay" in gallery
    assert "closeGalleryGrid(); // always open on the individual view" in gallery
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
    # Escape closes the sheet, not the gallery; Enter/Space opens the selection.
    assert "if (e.key === 'Escape') { e.preventDefault(); closeGalleryGrid(); return; }" in gallery
    assert "galleryGridSelect(galleryIdx);" in gallery
    # Arrows move by one / by a row.
    assert ": e.key === 'ArrowUp' ? -galleryGridCols" in gallery
    assert ": e.key === 'ArrowDown' ? galleryGridCols" in gallery
    # No badges on the thumbs (decision) and no shortcut for the sheet.
    assert "gallery-thumb-badge" not in gallery
    assert "galleryGridBadge" not in gallery
