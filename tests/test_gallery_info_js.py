"""Static regression guard for the fullscreen gallery ℹ️ button.

The old download button was replaced by image information. This keeps the
template, the JS wiring and the CSS hook from drifting apart.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERLAY = (ROOT / "templates" / "partials" / "gallery_overlay.html").read_text(encoding="utf-8")
GALLERY = (ROOT / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
CSS = (ROOT / "static" / "css" / "components.css").read_text(encoding="utf-8")


def test_overlay_has_info_button_and_panel_instead_of_download():
    assert 'id="galleryInfo"' in OVERLAY
    assert 'id="galleryInfoPanel"' in OVERLAY
    assert 'id="galleryInfoRows"' in OVERLAY
    assert 'id="galleryDl"' not in OVERLAY
    assert "gallery-dl" not in OVERLAY


def test_gallery_js_opens_info_and_closes_it_with_other_boxes():
    assert "function galleryShowInfo()" in GALLERY
    assert "galleryInfoBtn.addEventListener('click'" in GALLERY
    assert "galleryInfoPanel.classList.contains('show')" in GALLERY
    assert "function galleryDownload()" not in GALLERY
    # The panel must not survive navigation/closing or a fullscreen exit.
    assert "closeGalleryInfo();" in GALLERY


def test_css_has_info_button_and_panel():
    assert ".gallery-info { top: 14px; left: 14px; }" in CSS
    assert ".gallery-info-panel" in CSS
    assert ".gallery-info-lora" in CSS
