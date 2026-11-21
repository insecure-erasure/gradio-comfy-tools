"""Static guard for the ℹ️ information panel in the NORMAL (pane) view.

The same fixed panel serves the fullscreen gallery and the panes: each pane
has an ℹ️ button at its top-left, the `i` key toggles it, and a click outside
(backdrop) / `i` again / Escape close it.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


def _pane_partials():
    return (
        ("tab_generate.html", "generate"),
        ("tab_edit.html", "edit"),
        ("tab_face_swap.html", "face_swap"),
        ("tab_upscale.html", "upscale"),
        ("tab_video.html", "video"),
    )


def test_every_pane_has_an_info_button():
    for partial, tab in _pane_partials():
        body = _read("templates", "partials", partial)
        assert 'class="output-overlay-btn top-left pane-info-btn"' in body, partial
        assert f"paneShowInfo('{tab}')" in body, partial
        # Positioned by the generic top-left rule, not per-pane CSS.
        assert "id=\"galleryInfoPanel\"" not in body


def test_panel_is_top_level_and_fixed():
    panel = _read("templates", "partials", "info_panel.html")
    overlay = _read("templates", "partials", "gallery_overlay.html")
    index = _read("templates", "index.html")
    assert 'id="galleryInfoPanel"' in panel
    assert 'id="galleryInfoPanel"' not in overlay
    assert "partials/info_panel.html" in index
    css = _read("static", "css", "components.css")
    assert ".output-overlay-btn.top-left { top: 12px; left: 12px; }" in css
    block = css[css.index(".gallery-info-panel {"):]
    block = block[: block.index("}")]
    assert "position: fixed" in block
    assert ".gallery-info-panel.pane-mode { pointer-events: auto; }" in css
    # Pane mode: the BOX centers on the image (the anchor pane), not on the
    # viewport, while the backdrop keeps covering the screen.
    assert ".gallery-info-panel.pane-mode .gallery-info-box {" in css
    assert "left: var(--info-cx, 50%);" in css
    assert "top: var(--info-cy, 50%);" in css
    assert "transform: translate(-50%, -50%);" in css
    assert "var(--info-max-w, 90vw)" in css
    assert "var(--info-max-h, 100dvh)" in css
    # The pane button is not clickable while the pane shows a live preview.
    assert ".output-pane.generating .pane-info-btn" in css


def test_pane_info_toggles_and_shares_the_panel():
    gallery = _read("static", "js", "gallery.js")
    assert "function paneShowInfo(tab)" in gallery
    assert "async function _openInfoPanel(opts)" in gallery
    # The gallery keeps its own wrapper over the shared opener.
    assert "async function galleryShowInfo()" in gallery
    # Pane mode: backdrop dismiss + explicit cleanup.
    assert "galleryInfoPanel.classList.toggle('pane-mode', !!paneMode)" in gallery
    assert "galleryInfoPanel.classList.remove('pane-mode')" in gallery
    assert "galleryInfoPanel.addEventListener('click'" in gallery
    # The Fullscreen API renders only the fullscreen element: the shared panel
    # (body-level in the markup) is re-parented into it before showing.
    assert "function _mountInfoPanel()" in gallery
    assert "document.fullscreenElement || document.webkitFullscreenElement" in gallery
    assert "if (galleryInfoPanel.parentElement !== parent) parent.appendChild(galleryInfoPanel);" in gallery
    assert "_mountInfoPanel(); // a body-level panel would not render in fullscreen" in gallery
    # Videos in the pane: skip downloading the MP4.
    assert "skipMedia: isVideo" in gallery
    # Centered on the output pane (not the viewport) and kept in place when
    # the layout changes.
    assert "function _positionInfoPanel()" in gallery
    assert "anchorEl: pane" in gallery
    assert "window.addEventListener('resize', _positionInfoPanel);" in gallery
    assert "window.addEventListener('orientationchange', _positionInfoPanel);" in gallery
    assert "function _clearInfoAnchor()" in gallery


def test_i_key_and_escape_work_in_the_normal_view():
    main = _read("static", "js", "main.js")
    assert "paneShowInfo(currentTab)" in main
    assert "String(e.key).toLowerCase() === 'i'" in main
    # The panel blocks ←/→/Delete behind it...
    assert "#galleryInfoPanel.show" in main
    # ...but the i/Escape handler must skip that one entry to still close it.
    assert "sel !== '#galleryInfoPanel.show'" in main
    # The panel is closed on tab switch and when a pane is cleared.
    assert "closeGalleryInfo()" in _read("static", "js", "tabs.js")
    assert "closeGalleryInfo()" in _read("static", "js", "api.js")


def test_info_endpoint_is_reused():
    gallery = _read("static", "js", "gallery.js")
    assert "'/api/image-info?filename='" in gallery
    assert "fileTypeFromUrl(src)" in gallery
