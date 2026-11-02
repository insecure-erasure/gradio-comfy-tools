"""Node/structural tests for the adjust panel and its pure helpers."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE_TESTS = [
    ROOT / "tests" / "js" / "adjust_utils_test.js",
    ROOT / "tests" / "js" / "adjust_editor_test.js",
]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required for the JS unit tests")
@pytest.mark.parametrize("node_test", NODE_TESTS)
def test_adjust_node_unit_tests(node_test):
    proc = subprocess.run(
        ["node", str(node_test)], capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, "\n" + proc.stdout + proc.stderr


def _read(*parts: str) -> str:
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8")


def test_adjust_assets_load_in_order():
    html = _read("templates", "index.html")
    utils = html.index("/static/js/adjust-utils.js")
    panel = html.index("/static/js/adjust.js")
    main = html.index("/static/js/main.js")
    assert utils < panel < main


def test_edit_pane_includes_the_adjust_panel():
    tab = _read("templates", "partials", "tab_edit.html")
    assert 'include "partials/adjust_panel.html"' in tab
    panel = _read("templates", "partials", "adjust_panel.html")
    for el_id in (
        "adjustOverlay",
        "adjustImage",
        "adjustBrightness",
        "adjustContrast",
        "adjustSaturation",
        "adjustApply",
        "adjustCancel",
    ):
        assert f'id="{el_id}"' in panel


def test_adjust_panel_is_fullscreen_only_on_the_stacked_layout():
    css = _read("static", "css", "responsive.css")
    marker = css.index(".adjust-overlay")
    assert "@media (max-width: 1023px)" in css
    assert "position: fixed" in css[marker:marker + 500]


def test_edit_exposes_the_adjust_trigger_and_request():
    tab = _read("templates", "partials", "tab_edit.html")
    assert 'id="editAdjustBtn"' in tab
    assert "openEditAdjust()" in tab

    edit = _read("static", "js", "edit.js")
    assert "function openEditAdjust()" in edit
    assert "function submitAdjust(target, payload)" in edit
    assert "mode: 'adjust'" in edit
    assert "configureEditExtendToggle(true, 'Adjusted')" in edit
    assert "kind: 'adjust'" in edit
    assert "appendTransformedEntry(res, '', 'adjusted'" in edit


def test_adjust_results_join_the_gallery_and_recovery():
    gallery = _read("static", "js", "gallery.js")
    assert "kind === 'adjust' ? 'Adjusted'" in gallery
    assert "e.kind === 'extend' || e.kind === 'crop' || e.kind === 'adjust'" in gallery

    api = _read("static", "js", "api.js")
    assert "mode === 'adjust' ? 'adjusted'" in api

    restore = _read("static", "js", "restore.js")
    assert "kind === 'extend' || kind === 'crop' || kind === 'adjust'" in restore


def test_adjust_overlay_blocks_global_shortcuts_and_tab_switch_closes_it():
    main = _read("static", "js", "main.js")
    assert "#adjustOverlay.show" in main
    tabs = _read("static", "js", "tabs.js")
    assert "closeAdjustEditor()" in tabs
    assert "closeAdjustEditor()" in _read("static", "js", "api.js")


def test_adjust_sliders_use_relative_percent():
    panel = _read("templates", "partials", "adjust_panel.html")
    assert panel.count('min="-100" max="100" step="1" value="0"') == 3
    assert '>0%</output>' in panel


def test_adjust_controls_live_in_one_bottom_strip_with_action_column():
    panel = _read("templates", "partials", "adjust_panel.html")
    assert "adjust-topbar" not in panel
    assert "adjustTitle" not in panel
    assert "adjust-controls" in panel
    assert "adjust-sliders" in panel
    assert "adjust-actions" in panel
    reset = panel.index('id="adjustReset"')
    cancel = panel.index('id="adjustCancel"')
    apply = panel.index('id="adjustApply"')
    assert reset < cancel < apply
