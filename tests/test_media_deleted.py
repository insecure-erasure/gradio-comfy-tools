"""Tests for the ComfyUI cleanup hook (POST /api/media-deleted → /ws/events).

The hook is how the browser learns about deletions WITHOUT polling and
WITHOUT hiding files that still exist: ComfyUI's cleanup task announces the
exact filenames it removed and every open browser drops those entries.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture
def broadcasts(monkeypatch):
    """Capture _broadcast_event calls instead of touching real sockets."""
    calls = []
    monkeypatch.setattr(server, "_broadcast_event", lambda payload: calls.append(payload))
    return calls


@pytest.fixture(autouse=True)
def _no_event_loop():
    """Never leak the (closed) test loop into another test."""
    old_loop, old_clients = server._event_loop, dict(server._event_clients)
    yield
    server._event_loop = old_loop
    with server._event_clients_lock:
        server._event_clients.clear()
        server._event_clients.update(old_clients)


def test_broadcasts_the_deleted_filenames(client, broadcasts):
    r = client.post("/api/media-deleted", json={"filenames": ["a.png", "b.png", "a.png"]})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "count": 2}  # deduplicated
    assert broadcasts == [{"deleted": ["a.png", "b.png"]}]


def test_accepts_deleted_alias_and_trims(client, broadcasts):
    r = client.post("/api/media-deleted", json={"deleted": ["  x.png  "]})
    assert r.status_code == 200
    assert broadcasts == [{"deleted": ["x.png"]}]


def test_empty_list_is_a_no_op(client, broadcasts):
    r = client.post("/api/media-deleted", json={"filenames": []})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "count": 0}
    assert broadcasts == []


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"filenames": "a.png"},
        {"filenames": [1]},
        {"filenames": [""]},
        {"filenames": ["bad\x00name"]},
        {"filenames": ["x" * 513]},
    ],
)
def test_rejects_malformed_payloads(client, broadcasts, body):
    r = client.post("/api/media-deleted", json=body)
    assert r.status_code == 400
    assert broadcasts == []


def test_rejects_too_many_filenames(client, broadcasts):
    r = client.post("/api/media-deleted", json={"filenames": [f"f{i}.png" for i in range(501)]})
    assert r.status_code == 413
    assert broadcasts == []


def test_token_is_optional_but_enforced_when_set(client, broadcasts, monkeypatch):
    monkeypatch.setenv("MEDIA_DELETED_TOKEN", "s3cret")
    assert client.post("/api/media-deleted", json={"filenames": ["a.png"]}).status_code == 401
    bad = client.post(
        "/api/media-deleted", json={"filenames": ["a.png"]}, headers={"X-Media-Token": "nope"}
    )
    assert bad.status_code == 401
    ok = client.post(
        "/api/media-deleted", json={"filenames": ["a.png"]}, headers={"X-Media-Token": "s3cret"}
    )
    assert ok.status_code == 200
    assert broadcasts == [{"deleted": ["a.png"]}]


class _FakeQueue:
    def __init__(self):
        self.items = []

    def put_nowait(self, value):
        self.items.append(value)


class _FakeLoop:
    def __init__(self):
        self.closed = False

    def call_soon_threadsafe(self, fn, *args):
        fn(*args)

    def is_closed(self):
        return self.closed


def test_broadcast_fans_out_to_every_client():
    q1, q2 = _FakeQueue(), _FakeQueue()
    server._event_loop = _FakeLoop()
    with server._event_clients_lock:
        server._event_clients[object()] = q1
        server._event_clients[object()] = q2

    server._broadcast_event({"deleted": ["gone.png"]})

    assert q1.items == [{"deleted": ["gone.png"]}]
    assert q2.items == [{"deleted": ["gone.png"]}]


def test_broadcast_is_a_no_op_without_a_live_loop():
    q = _FakeQueue()
    server._event_loop = None
    with server._event_clients_lock:
        server._event_clients[object()] = q
    server._broadcast_event({"deleted": ["x.png"]})
    assert q.items == []

    server._event_loop = _FakeLoop()
    server._event_loop.closed = True
    server._broadcast_event({"deleted": ["x.png"]})
    assert q.items == []


def test_ws_events_delivers_a_broadcast(client):
    with client.websocket_connect("/ws/events") as ws:
        server._broadcast_event({"deleted": ["gone.png"]})
        assert ws.receive_json() == {"deleted": ["gone.png"]}
