"""State hub: the backend copy of the frontend store, pushed over WebSocket.

Two kinds of keys:
  * "set" keys are replaced wholesale; only keys whose JSON changed since the
    last flush go into a patch.
  * ring buffers are append-only; a patch carries just the new items and the
    client trims to the same caps as src/lib/store/sentinel-store.ts.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("sentinel.hub")

RING_CAPS = {
    "logs": 1000,
    "events": 200,
    "terminalLines": 200,
    "clusterHistory": 60,
    "clusterTrail": 61,
    "anomalyHistory": 120,
}
HISTORY_CAP = 60


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class Hub:
    def __init__(self) -> None:
        self.state: dict[str, Any] = {}
        self.rings: dict[str, deque] = {k: deque(maxlen=c) for k, c in RING_CAPS.items()}
        self.histories: dict[str, deque] = {}
        self._pending: dict[str, list] = {k: [] for k in RING_CAPS}
        self._pending_hist: dict[str, list] = {}
        self._last: dict[str, str] = {}
        self._notifications: list[dict] = []
        self.clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ write

    def set(self, **values: Any) -> None:
        self.state.update(values)

    def get(self, key: str, default: Any = None) -> Any:
        return self.state.get(key, default)

    def append(self, key: str, item: dict) -> None:
        self.rings[key].append(item)
        self._pending[key].append(item)

    def append_history(self, service_id: str, sample: dict) -> None:
        ring = self.histories.setdefault(service_id, deque(maxlen=HISTORY_CAP))
        ring.append(sample)
        self._pending_hist.setdefault(service_id, []).append(sample)

    def notify(self, level: str, title: str, description: str | None = None) -> None:
        self._notifications.append({"level": level, "title": title, "description": description})

    # ------------------------------------------------------------------- read

    def snapshot(self) -> dict:
        snap = dict(self.state)
        for key, ring in self.rings.items():
            snap[key] = list(ring)
        snap["histories"] = {k: list(v) for k, v in self.histories.items()}
        return snap

    def _build_patch(self) -> dict | None:
        changed: dict[str, Any] = {}
        for key, value in self.state.items():
            encoded = dumps(value)
            if self._last.get(key) != encoded:
                self._last[key] = encoded
                changed[key] = value
        append: dict[str, Any] = {}
        for key, items in self._pending.items():
            if items:
                append[key] = items
        if self._pending_hist:
            append["histories"] = self._pending_hist
        self._pending = {k: [] for k in RING_CAPS}
        self._pending_hist = {}
        if not changed and not append:
            return None
        return {"type": "patch", "set": changed, "append": append}

    # -------------------------------------------------------------- transport

    async def connect(self, ws: WebSocket) -> None:
        async with self._lock:
            # Flush first so pending appends are not delivered twice (once in
            # the snapshot, once in the next patch).
            await self._flush_locked()
            self.clients.add(ws)
            await ws.send_text(dumps({"type": "snapshot", "state": self.snapshot()}))

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def send_snapshot(self, ws: WebSocket) -> None:
        async with self._lock:
            await self._flush_locked()
            await ws.send_text(dumps({"type": "snapshot", "state": self.snapshot()}))

    async def broadcast_snapshot(self) -> None:
        async with self._lock:
            await self._flush_locked()
            message = dumps({"type": "snapshot", "state": self.snapshot()})
            await self._send_all([message])

    async def flush(self) -> None:
        async with self._lock:
            await self._flush_locked()

    async def _flush_locked(self) -> None:
        patch = self._build_patch()
        notes, self._notifications = self._notifications, []
        messages = []
        if patch:
            messages.append(dumps(patch))
        for n in notes:
            messages.append(dumps({"type": "notify", **n}))
        if messages and self.clients:
            await self._send_all(messages)

    async def _send_all(self, messages: list[str]) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                for m in messages:
                    await asyncio.wait_for(ws.send_text(m), timeout=2)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)
