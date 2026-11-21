"""Static checks for the Edit Color match (🎨) defaults.

Edit starts at 0.25 (soft palette match); Restore forces 0; Extend keeps its
own 0.5 default once a padding changes. The workflow JSON stays at 0.0 so API
clients that omit `color_match` keep the previous behaviour.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


def test_edit_pane_defaults_to_a_quarter_strength():
    tab = _read("templates", "partials", "tab_edit.html")
    assert 'id="editColorMatch" value="0.25"' in tab
    edit = _read("static", "js", "edit.js")
    assert "const EDIT_COLOR_MATCH_DEFAULT = 0.25;" in edit


def test_reset_uses_the_same_default():
    edit = _read("static", "js", "edit.js")
    # ↺ restores the constant (not a hardcoded 0).
    assert "colorMatch.value = String(EDIT_COLOR_MATCH_DEFAULT)" in edit


def test_restore_still_forces_zero_and_extend_keeps_its_own_default():
    edit = _read("static", "js", "edit.js")
    assert "if (mode === 'restore') _setEditColorMatchValue(0);" in edit
    assert "const EDIT_EXTEND_COLOR_MATCH_DEFAULT = 0.5;" in edit


def test_workflow_json_keeps_the_no_op_api_default():
    wf = json.loads((ROOT / "workflows" / "edit_image.json").read_text(encoding="utf-8"))
    strengths = [
        node["inputs"]["strength"]
        for node in wf.values()
        if (node.get("_meta") or {}).get("title") == "Color Match"
    ]
    assert strengths == [0.0]
