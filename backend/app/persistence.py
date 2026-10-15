"""Platform persistence (PostgreSQL, JSONB documents).

Writes go through a single background thread so the control loop never blocks
on the database. If the database is unreachable the platform keeps running in
memory and retries on the next write.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time

import psycopg

log = logging.getLogger("sentinel.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    kind TEXT NOT NULL,
    id   TEXT NOT NULL,
    ts   BIGINT NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS docs_kind_ts ON docs (kind, ts DESC);
CREATE TABLE IF NOT EXISTS kv (
    key  TEXT PRIMARY KEY,
    data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    seq  BIGSERIAL PRIMARY KEY,
    ts   BIGINT NOT NULL,
    data JSONB NOT NULL
);
"""


class Store:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.enabled = bool(dsn)
        self._q: queue.Queue = queue.Queue()
        self._conn: psycopg.Connection | None = None
        self.ok = False
        if self.enabled:
            threading.Thread(target=self._writer, daemon=True).start()

    def _connect(self) -> psycopg.Connection:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self.dsn, autocommit=True, connect_timeout=3)
        return self._conn

    def init(self, attempts: int = 20) -> None:
        if not self.enabled:
            log.warning("SENTINEL_DB_DSN not set — running without persistence")
            return
        for i in range(attempts):
            try:
                conn = psycopg.connect(self.dsn, autocommit=True, connect_timeout=3)
                conn.execute(SCHEMA)
                conn.close()
                self.ok = True
                log.info("platform database ready")
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("database not ready (%s/%s): %s", i + 1, attempts, exc)
                time.sleep(1.5)
        log.error("database unavailable — continuing in memory only")

    # ------------------------------------------------------------------ reads

    def load(self, kind: str, limit: int) -> list[dict]:
        if not self.ok:
            return []
        try:
            with psycopg.connect(self.dsn, autocommit=True, connect_timeout=3) as c:
                rows = c.execute(
                    "SELECT data FROM docs WHERE kind = %s ORDER BY ts DESC LIMIT %s", (kind, limit)
                ).fetchall()
            return [r[0] for r in reversed(rows)]
        except Exception as exc:  # noqa: BLE001
            log.warning("load %s failed: %s", kind, exc)
            return []

    def get(self, key: str):
        if not self.ok:
            return None
        try:
            with psycopg.connect(self.dsn, autocommit=True, connect_timeout=3) as c:
                row = c.execute("SELECT data FROM kv WHERE key = %s", (key,)).fetchone()
            return row[0] if row else None
        except Exception as exc:  # noqa: BLE001
            log.warning("get %s failed: %s", key, exc)
            return None

    # ----------------------------------------------------------------- writes

    def upsert(self, kind: str, doc_id: str, ts: int, data: dict) -> None:
        if self.enabled:
            self._q.put(("doc", kind, doc_id, ts, json.dumps(data)))

    def put(self, key: str, data) -> None:
        if self.enabled:
            self._q.put(("kv", key, json.dumps(data)))

    def audit(self, ts: int, data: dict) -> None:
        if self.enabled:
            self._q.put(("audit", ts, json.dumps(data)))

    def _writer(self) -> None:
        while True:
            item = self._q.get()
            for attempt in range(3):
                try:
                    c = self._connect()
                    if item[0] == "doc":
                        _, kind, doc_id, ts, data = item
                        c.execute(
                            """
                            INSERT INTO docs (kind, id, ts, data) VALUES (%s, %s, %s, %s::jsonb)
                            ON CONFLICT (kind, id) DO UPDATE SET ts = EXCLUDED.ts, data = EXCLUDED.data
                            """,
                            (kind, doc_id, ts, data),
                        )
                    elif item[0] == "kv":
                        _, key, data = item
                        c.execute(
                            """
                            INSERT INTO kv (key, data) VALUES (%s, %s::jsonb)
                            ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
                            """,
                            (key, data),
                        )
                    else:
                        _, ts, data = item
                        c.execute("INSERT INTO audit (ts, data) VALUES (%s, %s::jsonb)", (ts, data))
                    break
                except Exception as exc:  # noqa: BLE001
                    log.warning("db write failed (attempt %s): %s", attempt + 1, exc)
                    try:
                        if self._conn is not None:
                            self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._conn = None
                    time.sleep(1)
