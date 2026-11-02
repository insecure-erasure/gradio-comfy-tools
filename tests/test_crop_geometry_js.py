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
