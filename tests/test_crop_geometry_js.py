"""Node unit tests for the pure crop geometry helpers."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE_TEST = ROOT / "tests" / "js" / "crop_geometry_test.js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required for the JS unit tests")
def test_crop_geometry_unit_tests():
    proc = subprocess.run(
        ["node", str(NODE_TEST)], capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, "\n" + proc.stdout + proc.stderr


def _read(*parts: str) -> str:
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8")


def test_crop_assets_load_in_order():
    html = _read("templates", "index.html")
    geometry = html.index("/static/js/crop-geometry.js")
    editor = html.index("/static/js/crop.js")
    main = html.index("/static/js/main.js")
    assert geometry < editor < main


def test_edit_pane_includes_the_crop_editor():
    tab = _read("templates", "partials", "tab_edit.html")
    assert 'include "partials/crop_overlay.html"' in tab
    overlay = _read("templates", "partials", "crop_overlay.html")
    for el_id in ("cropOverlay", "cropStage", "cropBox", "cropApply", "cropCancel"):
        assert f'id="{el_id}"' in overlay


def test_crop_editor_is_fullscreen_only_on_the_stacked_layout():
    css = _read("static", "css", "responsive.css")
    assert "@media (max-width: 1023px)" in css
    assert ".crop-overlay" in css
    assert "position: fixed" in css


def test_edit_exposes_the_crop_trigger_and_request():
    tab = _read("templates", "partials", "tab_edit.html")
    assert 'id="editCropBtn"' in tab
    assert "openEditCrop()" in tab

    edit = _read("static", "js", "edit.js")
    assert "function openEditCrop()" in edit
    assert "function _editCropTarget()" in edit
    assert "mode: 'crop'" in edit
    assert "configureEditExtendToggle(true, 'Cropped')" in edit
    assert "addCompareEntry({" in edit
    assert "kind: 'crop'" in edit
    assert "appendTransformedEntry(res, '', 'cropped'" in edit


def test_crop_results_join_the_gallery_and_recovery():
    gallery = _read("static", "js", "gallery.js")
    assert "kind === 'crop' ? 'Cropped'" in gallery
    assert "e.kind === 'extend' || e.kind === 'crop'" in gallery

    api = _read("static", "js", "api.js")
    assert "mode === 'crop' ? 'cropped'" in api

    restore = _read("static", "js", "restore.js")
    assert "kind === 'extend' || kind === 'crop'" in restore


def test_crop_overlay_blocks_global_shortcuts_and_tab_switch_closes_it():
    main = _read("static", "js", "main.js")
    assert "#cropOverlay.show" in main
    tabs = _read("static", "js", "tabs.js")
    assert "closeCropEditor()" in tabs
