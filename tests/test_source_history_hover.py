"""Regression guard for the 🕘 thumbnail preview.

The popover grid is a scroll box (`overflow-y: auto`) inside a fixed popover,
so the larger uncropped preview MUST be a fixed-position card in `<body>` —
anything rendered inside the popover gets clipped by that scroll box. It also
has to overlay the hovered thumbnail (not sit beside the popover) while staying
subtle: earlier attempts zoomed the cell out or crossfaded two copies in
place, which read like the thumbnail receding instead of a preview.

These tests pin the pieces that break silently: no browser is needed.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = (ROOT / "static" / "css" / "components.css").read_text(encoding="utf-8")
HTML = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
JS = (ROOT / "static" / "js" / "source.js").read_text(encoding="utf-8")


def _rule(selector: str) -> str:
    """Declarations of the exact rule `selector { ... }` (not `.selector-x`)."""
    match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", CSS)
    assert match, f"missing rule: {selector}"
    return match.group(1)


def test_thumbnails_remain_square_cover_crops():
    body = _rule(".source-history-item img")
    assert "object-fit: cover" in body
    assert "aspect-ratio: 1" in body


def test_peek_card_is_fixed_and_lives_outside_the_popover():
    # Present in the markup...
    assert 'id="sourceHistoryPeek"' in HTML
    # ...after the popover/grid, i.e. NOT inside the scrollable grid.
    assert HTML.index('id="sourceHistoryPeek"') > HTML.index('id="sourceHistoryGrid"')
    body = _rule(".source-history-peek-card")
    assert "position: fixed" in body
    # Never steals the hover that opened it, so it can cover its own anchor.
    assert "pointer-events: none" in body
    # Subtle: fades in (no display toggle) instead of popping up hard.
    assert "opacity: 0" in body
    assert "opacity: 1" in _rule(".source-history-peek-card.show")
    # Whole image inside the card, regardless of aspect ratio.
    assert "object-fit: contain" in _rule(".source-history-peek-card img")


def test_peek_card_opens_on_the_hovered_thumbnail_not_beside_the_popover():
    # Anchored to the thumbnail's own box, then clamped inside the popover.
    assert "thumb.getBoundingClientRect()" in JS
    assert "pr.left + PEEK_INSET" in JS and "pr.right - PEEK_INSET - w" in JS
    # The old "put it next to the popover" branches are gone.
    assert "PEEK_GAP" not in JS
    # Still a preview, not a magnifier.
    scale = re.search(r"const PEEK_SCALE = ([\d.]+)", JS)
    assert scale and 1.0 < float(scale.group(1)) <= 2.0
    # Size from the thumbnail's RENDERED `cover` crop, not from the cell box:
    # a `contain` preview sized from the cell can look the same as the crop.
    assert "const coverScale = Math.max(tr.width / nw, tr.height / nh)" in JS
    assert "coverScale * PEEK_SCALE" in JS
    # Wide sources may be wider than the popover, so the viewport clamp stays.
    assert "window.innerWidth - PEEK_INSET - w" in JS


def test_peek_card_stacks_above_the_popover():
    def z_index(selector: str) -> int:
        match = re.search(r"z-index:\s*(\d+)", _rule(selector))
        assert match, f"{selector} has no z-index"
        return int(match.group(1))

    assert z_index(".source-history-peek-card") > z_index(".source-history-popover")


def test_pointer_and_keyboard_open_the_same_popout():
    assert "btn.addEventListener('mouseenter', () => showSourceHistoryPeek(btn))" in JS
    # Keyboard focus only: a mouse click focuses the card right before the
    # popover closes, and must not flash the preview.
    assert "btn.addEventListener('focus', () => {" in JS
    assert ":focus-visible" in JS
    for event in ("mouseleave", "blur"):
        assert f"btn.addEventListener('{event}', hideSourceHistoryPeek)" in JS
    close = re.search(r"function closeSourceHistory\(\) \{([^}]*)\}", JS)
    assert close and "hideSourceHistoryPeek()" in close.group(1)


def test_no_in_place_zoom_or_crossfade_leftovers():
    # The old hover behaviour must not come back: it looked like a zoom-out.
    for dead in ("scale(.97)", "scale(.94)", ".source-history-frame", ".source-history-peek {"):
        assert dead not in CSS
