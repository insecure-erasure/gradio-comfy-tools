"""Guards for replacing the Edit result view with a new source preview."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "static" / "js" / "source.js").read_text(encoding="utf-8")


def _function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start)
    return source[start:end]


def test_loading_a_source_hides_the_compare_toggle():
    body = _function_body(SOURCE, "function previewSourceImage(tab, src)")
    # The crop/adjust/extend comparison toggle is not a .compare-slider: it
    # must be hidden explicitly when a new source preview replaces it.
    assert ".extend-toggle" in body
    assert "extend-toggle-mode" in body
    assert "show-original" in body
    assert "el.style.display = 'none'" in body
