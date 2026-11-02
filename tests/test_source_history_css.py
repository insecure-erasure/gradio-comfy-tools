"""Cascade regression test for the 🕘 thumbnail reveal.

The 🕘 popover stacks two copies of each thumbnail inside
`.source-history-frame`: a square `cover` base and a `contain` peek that
crossfades in on hover/focus. Both share the element rule
`.source-history-frame img` (specificity 0,1,1), so putting `object-fit`
there silently outranks `.source-history-peek` (0,1,0): the peek keeps
`cover`, looks identical to the base, and hovering never reveals the
uncropped image. `object-fit` must therefore live on the single-class
layer rules only.
"""

from __future__ import annotations

import re
from pathlib import Path

CSS_PATH = (
    Path(__file__).resolve().parent.parent / "static" / "css" / "components.css"
)


def _object_fit_rules() -> dict[str, str]:
    css = re.sub(r"/\*.*?\*/", "", CSS_PATH.read_text(encoding="utf-8"), flags=re.S)
    fits: dict[str, str] = {}
    for block in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        match = re.search(r"object-fit:\s*([a-z-]+)", block.group(2))
        if not match:
            continue
        for selector in block.group(1).split(","):
            selector = selector.strip()
            if "source-history" in selector:
                fits[selector] = match.group(1)
    return fits


def test_thumbnail_layers_keep_their_own_object_fit():
    fits = _object_fit_rules()

    # A shared element rule (or any compound selector) would outrank the
    # single-class layer rules and freeze the peek on `cover`.
    compound = {sel for sel in fits if not re.fullmatch(r"\.[\w-]+", sel)}
    assert not compound, f"object-fit must use single-class selectors: {sorted(compound)}"

    assert fits.get(".source-history-base") == "cover"
    assert fits.get(".source-history-peek") == "contain"


def test_reveal_is_wired_to_hover_and_focus_without_zoom_out():
    css = CSS_PATH.read_text(encoding="utf-8")
    for state in (":hover", ":focus-visible"):
        assert (
            f".source-history-item{state} "
            ".source-history-frame:not(.broken) .source-history-peek"
        ) in css
    # The reveal must stay a crossfade: a scale-down reads as the card
    # receding and cannot be animated together with the object-fit swap.
    assert "scale(.97)" not in css
    assert "scale(.94)" not in css
