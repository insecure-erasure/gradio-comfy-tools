"""Static checks for the pane compare presentation (toggle, top-center).

The NORMAL (pane) view never uses the draggable overlay slider: Edit,
Upscale and Face swap show one image at a time with an `Original | Result`
toggle centered at the top of the pane (static/js/pane-compare.js). The
FULLSCREEN gallery keeps its own per-kind presentation.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE_TEST = ROOT / "tests" / "js" / "pane_compare_test.js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required for the JS unit tests")
def test_pane_compare_unit_tests():
    proc = subprocess.run(
        ["node", str(NODE_TEST)], capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, "\n" + proc.stdout + proc.stderr


def _read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


def test_pane_compare_asset_loads_before_its_consumers():
    html = _read("templates", "index.html")
    pane_compare = html.index("/static/js/pane-compare.js")
    for later in (
        "/static/js/edit.js",
        "/static/js/upscale.js",
        "/static/js/face_swap.js",
        "/static/js/restore.js",
        "/static/js/gallery.js",
    ):
        assert pane_compare < html.index(later), later


def test_every_compare_pane_has_a_toggle():
    for partial, toggle_id in (
        ("tab_edit.html", "editExtendToggle"),
        ("tab_upscale.html", "upscaleCompareToggle"),
        ("tab_face_swap.html", "faceSwapCompareToggle"),
    ):
        body = _read("templates", "partials", partial)
        assert f'id="{toggle_id}"' in body
        # Both buttons drive the shared generic handler.
        assert "setPaneCompareView(" in body


def test_slider_carries_the_pane_toggle_ids():
    src = _read("static", "js", "pane-compare.js")
    for tab, slider in (
        ("edit", "editCompare"),
        ("upscale", "upscaleCompare"),
        ("face_swap", "faceSwapCompare"),
    ):
        assert f"slider: '{slider}'" in src
        assert f"{tab}: {{" in src


def test_pane_toggle_is_always_enabled_for_every_mode():
    edit = _read("static", "js", "edit.js")
    # Edit / Restore / Extend: the pane is ALWAYS the toggle now (the old
    # `configureEditExtendToggle(mode === 'extend')` limited it to Extend).
    assert "configureEditExtendToggle(mode === 'extend')" not in edit
    assert "configureEditExtendToggle(true, mode === 'restore' ? 'Restored'" in edit
    assert "configureEditExtendToggle(true, 'Cropped')" in edit
    assert "configureEditExtendToggle(true, 'Adjusted')" in edit
    upscale = _read("static", "js", "upscale.js")
    assert "configurePaneCompare('upscale', true, 'Upscaled')" in upscale
    face = _read("static", "js", "face_swap.js")
    assert "configurePaneCompare('face_swap', true, 'Face swapped')" in face


def test_restore_uses_the_toggle_for_every_compare_tab():
    restore = _read("static", "js", "restore.js")
    assert "configurePaneCompare(" in restore
    # The old condition restricted the toggle to edit + extend/crop/adjust.
    assert "paneId === 'editOutputPane' && typeof configureEditExtendToggle" not in restore


def test_toggle_css_is_centered_and_above_the_image():
    css = _read("static", "css", "components.css")
    block = css[css.index(".extend-toggle {"):]
    block = block[: block.index("}")]
    assert "left: 50%" in block
    assert "translateX(-50%)" in block
    assert "top: 12px" in block


def test_gallery_keeps_its_own_presentation():
    gallery = _read("static", "js", "gallery.js")
    # The fullscreen gallery switches to the toggle ONLY for the kinds that
    # change the canvas (extend/crop); edit/restore/upscale/face swap/adjust
    # keep the draggable slider.
    assert "e.kind === 'extend' || e.kind === 'crop'" in gallery
    assert "e.kind === 'extend' || e.kind === 'crop' || e.kind === 'adjust'" not in gallery
