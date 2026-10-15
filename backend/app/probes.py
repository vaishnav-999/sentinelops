"""Application-level probes: each container's /stats, Redis INFO, Postgres xacts."""

from __future__ import annotations

import asyncio
import logging
import time

import httpx
import psycopg
import redis.asyncio as aioredis

from . import config
from .catalog import SERVICE_BY_ID

log = logging.getLogger("sentinel.probes")


class Prober:
    def __init__(self) -> None:
        self.http = httpx.AsyncClient(timeout=config.PROBE_TIMEOUT_SEC)
        self.redis = aioredis.Redis(
            host=config.REDIS_HOST, db=0, socket_timeout=config.PROBE_TIMEOUT_SEC,
            socket_connect_timeout=config.PROBE_TIMEOUT_SEC,
        )
        self._redis_prev: dict | None = None
        self._hit_window: list[tuple[float, int, int]] = []
        self._last_hit_rate: float | None = None
        self._pg_conn: psycopg.Connection | None = None
        self._pg_prev: tuple[float, int] | None = None
        self._pg_rate: float = 0.0

    async def close(self) -> None:
        await self.http.aclose()
        await self.redis.aclose()

    # ------------------------------------------------------------- app stats

    async def app_stats(self, containers: list[dict]) -> dict[str, dict | None]:
        """containers: running app containers with ip. Returns id -> stats|None."""

        async def one(info: dict):
            port = SERVICE_BY_ID[info["service"]]["port"]
            try:
                r = await self.http.get(f"http://{info['ip']}:{port}/stats")
                r.raise_for_status()
                return info["id"], r.json()
            except Exception:  # noqa: BLE001
                return info["id"], None

        results = await asyncio.gather(*(one(c) for c in containers if c.get("ip")))
        return dict(results)

    async def post_chaos(self, info: dict, path: str) -> None:
        port = SERVICE_BY_ID[info["service"]]["port"]
        r = await self.http.post(f"http://{info['ip']}:{port}{path}", timeout=3.0)
        r.raise_for_status()

    # ------------------------------------------------------------------ redis

    async def redis_stats(self) -> dict | None:
        try:
            started = time.perf_counter()
            await self.redis.ping()
            ping_ms = (time.perf_counter() - started) * 1000
            info = await self.redis.info("all")
        except Exception:  # noqa: BLE001
            self._redis_prev = None
            return None

        now = time.monotonic()
        used = int(info.get("used_memory", 0))
        maxmem = int(info.get("maxmemory", 0)) or int(info.get("total_system_memory", 1))
        hits = int(info.get("keyspace_hits", 0))
        misses = int(info.get("keyspace_misses", 0))
        total_cmds = int(info.get("total_commands_processed", 0))
        oom = 0
        err = info.get("errorstat_OOM")
        if isinstance(err, dict):
            oom = int(err.get("count", 0))

        self._hit_window.append((now, hits, misses))
        self._hit_window = [w for w in self._hit_window if now - w[0] <= 10]
        first = self._hit_window[0]
        d_hits, d_miss = hits - first[1], misses - first[2]
        if d_hits + d_miss >= 5:
            self._last_hit_rate = round(d_hits / (d_hits + d_miss) * 100, 1)

        error_rate = 0.0
        prev = self._redis_prev
        if prev is not None:
            d_cmds = total_cmds - prev["cmds"]
            d_oom = oom - prev["oom"]
            if d_cmds > 0 and d_oom > 0:
                error_rate = round(min(100.0, d_oom / d_cmds * 100), 2)
        self._redis_prev = {"cmds": total_cmds, "oom": oom}

        return {
            "memory": round(min(100.0, used / maxmem * 100), 1) if maxmem else 0.0,
            "usedBytes": used,
            "maxBytes": maxmem,
            "latencyP95": round(ping_ms, 1),
            "throughput": int(info.get("instantaneous_ops_per_sec", 0)) * 60,
            "hitRate": self._last_hit_rate,
            "errorRate": error_rate,
        }

    # --------------------------------------------------------------- postgres

    def _pg_sample(self) -> float:
        if not config.TARGET_PG_DSN:
            return 0.0
        try:
            if self._pg_conn is None or self._pg_conn.closed:
                self._pg_conn = psycopg.connect(config.TARGET_PG_DSN, autocommit=True, connect_timeout=2)
            row = self._pg_conn.execute(
                "SELECT COALESCE(sum(xact_commit + xact_rollback), 0) FROM pg_stat_database"
            ).fetchone()
            total = int(row[0]) if row else 0
        except Exception:  # noqa: BLE001
            if self._pg_conn is not None:
                try:
                    self._pg_conn.close()
                except Exception:  # noqa: BLE001
                    pass
            self._pg_conn = None
            self._pg_prev = None
            return 0.0
        now = time.monotonic()
        if self._pg_prev is not None:
            dt = now - self._pg_prev[0]
            if dt >= 0.5:
                # Subtract the probe's own transaction.
                self._pg_rate = max(0.0, (total - self._pg_prev[1] - 1) / dt * 60)
                self._pg_prev = (now, total)
        else:
            self._pg_prev = (now, total)
        return self._pg_rate

    async def postgres_tpm(self) -> float:
        return await asyncio.to_thread(self._pg_sample)
