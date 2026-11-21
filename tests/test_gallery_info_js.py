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
UPSCALE = (ROOT / "static" / "js" / "upscale.js").read_text(encoding="utf-8")


def test_overlay_has_info_button_and_panel_instead_of_download():
    assert 'id="galleryInfo"' in OVERLAY
    assert 'id="galleryInfoPanel"' in OVERLAY
    assert 'id="galleryInfoRows"' in OVERLAY
    assert 'id="galleryDl"' not in OVERLAY
    assert "gallery-dl" not in OVERLAY
    # The old Show-prompt control was folded into the info panel.
    assert 'id="galleryPromptBtn"' not in OVERLAY
    assert 'id="galleryPromptModal"' not in OVERLAY
    assert "gallery-prompt-btn" not in OVERLAY
    assert "gallery-prompt-modal" not in OVERLAY


def test_gallery_js_opens_info_and_closes_it_with_other_boxes():
    assert "function galleryShowInfo()" in GALLERY
    assert "galleryInfoBtn.addEventListener('click'" in GALLERY
    assert "galleryInfoPanel.classList.contains('show')" in GALLERY
    assert "function galleryDownload()" not in GALLERY
    # The `i` key toggles the panel (handled before closeTextBoxes).
    assert "String(e.key).toLowerCase() === 'i'" in GALLERY
    # The prompt moved into the panel.
    assert "_appendGalleryInfoTextRow('Prompt'" in GALLERY
    assert "_appendGalleryInfoTextRow('Original prompt'" in GALLERY
    assert "galleryPromptBtn" not in GALLERY
    # Videos use the same panel: resolution from the <video> element and the
    # rest from history (skip_media avoids downloading the MP4).
    assert "_galleryInfoFallbackSize" in GALLERY
    assert "&skip_media=1" in GALLERY
    assert "galleryInfoBtn.style.display = 'none'" not in GALLERY


def test_upscale_compare_reuses_the_source_prompt():
    assert "function sourceImagePrompt(sourceSrc)" in GALLERY
    assert "sourceImagePrompt(src)" in UPSCALE
    # The panel must not survive navigation/closing or a fullscreen exit.
    assert "closeGalleryInfo();" in GALLERY


def test_css_has_info_button_and_panel():
    assert ".gallery-info { top: 14px; left: 14px; }" in CSS
    assert ".gallery-info-panel" in CSS
    assert ".gallery-info-lora" in CSS
    assert ".gallery-info-prompt" in CSS
