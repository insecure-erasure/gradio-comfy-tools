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
