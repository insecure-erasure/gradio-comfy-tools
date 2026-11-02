"""Node unit tests for the media-drop planner + wiring contract.

The planner (static/js/media-events.js) decides what a confirmed deletion
removes from each registry; it is pure, so it is tested in node and this
module only shells out to that runner. The wiring tests then pin the pieces
that are easy to detach silently (script order, dropMedia existing, the
one-shot probe feeding dropMedia instead of splicing arrays behind the UI).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE_TEST = ROOT / "tests" / "js" / "media_events_test.js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required for the JS unit tests")
def test_media_drop_planner_unit_tests():
    proc = subprocess.run(
        ["node", str(NODE_TEST)], capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, "\n" + proc.stdout + proc.stderr


def _read(*parts: str) -> str:
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8")


def test_the_page_loads_the_events_module_before_its_users():
    html = _read("templates", "index.html")
    events = html.index("/static/js/media-events.js")
    assert events < html.index("/static/js/storage.js")
    assert events < html.index("/static/js/gallery.js")


def test_main_subscribes_to_the_deletion_events():
    main = _read("static", "js", "main.js")
    assert "initMediaEvents()" in main
    assert "verifyStoredGalleries()" in main


def test_drop_media_is_the_single_removal_path():
    gallery = _read("static", "js", "gallery.js")
    assert "function dropMedia(" in gallery
    assert "mediaDropPlan(" in gallery
    # The three UI surfaces the user cares about: overlay counter (via
    # renderGalleryItem), pane ‹ › (syncPaneNav) and the 🕘 grid.
    assert "renderGalleryItem()" in gallery
    assert "syncPaneNav(tab)" in gallery
    assert "renderSourceHistoryGrid(_sourceHistoryTab)" in gallery


def test_restore_probe_goes_through_drop_media_instead_of_splicing():
    storage = _read("static", "js", "storage.js")
    assert "dropMedia(dead, { quiet: true })" in storage
    # No silent in-place surgery on the live registries any more.
    assert "entries.splice(" not in storage


def test_ws_events_client_drops_pushed_filenames():
    events = _read("static", "js", "media-events.js")
    assert "/ws/events" in events
    assert "payload.deleted" in events
    assert "dropMedia(payload.deleted)" in events


def test_preflight_paths_are_wired():
    storage = _read("static", "js", "storage.js")
    # A probe that cannot reach ComfyUI must keep the entry, never drop it.
    assert "j.unknown ? true" in storage
    assert "async function ensureEntryExists(" in storage
    assert "async function pruneSourceHistory(" in storage

    restore = _read("static", "js", "restore.js")
    assert "async function restoreTabResultChecked(" in restore
    assert "ensureEntryExists(entry)" in restore

    assert "restoreTabResultChecked(name)" in _read("static", "js", "tabs.js")
    assert "await pruneSourceHistory(tab)" in _read("static", "js", "source.js")
    assert "restoreTabResultChecked(currentTab)" in _read("static", "js", "gallery.js")


def test_failed_media_requests_reconcile_without_a_socket():
    events = _read("static", "js", "media-events.js")
    assert "document.addEventListener('error'" in events
    assert "_mediaExists(fn, type, true)" in events
    assert "dropMedia([fn])" in events
