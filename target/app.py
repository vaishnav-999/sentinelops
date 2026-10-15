"""
SentinelOps demo target system.

One image, five roles selected by the SERVICE env var:
  api-gateway, auth-service, orders-service      (HTTP services)
  payment-worker, notification-worker            (background workers)

Every role exposes:
  GET  /health        liveness
  GET  /stats         rolling request/job statistics (p95, error rate, throughput)
  POST /chaos/*       real fault injection used by the SentinelOps Chaos Lab

The faults are real: the memory leak really allocates, the crash really exits the
process, latency really sleeps, the CPU burn really consumes CPU time.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import queue
import random
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager, contextmanager

import httpx
import psycopg
import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

SERVICE = os.environ["SERVICE"]
PORT = int(os.environ.get("PORT", "8080"))
REDIS_HOST = os.environ.get("REDIS_HOST", "redis-cache")
PG_DSN = os.environ.get("PG_DSN", "")
AUTH_URL = os.environ.get("AUTH_URL", "http://auth-service:8081")
ORDERS_URL = os.environ.get("ORDERS_URL", "http://orders-service:8082")

WORKERS = {"payment-worker", "notification-worker"}
IS_WORKER = SERVICE in WORKERS

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(levelname)s %(message)s",
)
log = logging.getLogger(SERVICE)
logging.getLogger("httpx").setLevel(logging.WARNING)

STARTED_AT_MS = int(time.time() * 1000)


# --------------------------------------------------------------------------- #
# Rolling statistics                                                           #
# --------------------------------------------------------------------------- #


class Recorder:
    """Requests (or jobs) seen in the last `window` seconds."""

    def __init__(self, window: float = 20.0) -> None:
        self.window = window
        self.samples: deque[tuple[float, float, bool]] = deque()
        self.lock = threading.Lock()
        self.started = time.monotonic()

    def record(self, ms: float, ok: bool) -> None:
        now = time.monotonic()
        with self.lock:
            self.samples.append((now, ms, ok))
            self._trim(now)

    def _trim(self, now: float) -> None:
        while self.samples and now - self.samples[0][0] > self.window:
            self.samples.popleft()

    def snapshot(self) -> dict:
        now = time.monotonic()
        with self.lock:
            self._trim(now)
            items = list(self.samples)
        span = max(1.0, min(self.window, now - self.started))
        n = len(items)
        if n == 0:
            return {"count": 0, "errors": 0, "p95": 0.0, "errorRate": 0.0, "throughput": 0}
        durations = sorted(ms for _, ms, _ in items)
        p95 = durations[max(0, math.ceil(0.95 * n) - 1)]
        errors = sum(1 for _, _, ok in items if not ok)
        return {
            "count": n,
            "errors": errors,
            "p95": round(p95, 1),
            "errorRate": round(errors / n * 100, 2),
            "throughput": round(n * 60 / span),
        }


recorder = Recorder()


# --------------------------------------------------------------------------- #
# Chaos state (process-local: a restart genuinely clears it)                   #
# --------------------------------------------------------------------------- #


class Chaos:
    def __init__(self) -> None:
        self.leak_on = False
        self.leak: list[bytes] = []
        self.leak_mb_per_sec = 3
        self.latency_ms = 0
        self.mixed_until = 0.0
        self.cpu_burn_ms = 0  # gateway only, mirrored from Redis so replicas share it

    def mixed_active(self) -> bool:
        return time.monotonic() < self.mixed_until

    def describe(self) -> dict:
        return {
            "memoryLeak": self.leak_on,
            "leakedMb": len(self.leak) * self.leak_mb_per_sec,
            "latencyMs": self.latency_ms,
            "mixed": self.mixed_active(),
            "cpuBurnMs": self.cpu_burn_ms,
        }


chaos = Chaos()


def leak_loop() -> None:
    while True:
        time.sleep(1)
        if chaos.leak_on:
            # Filled (not zeroed) bytes so the pages are really committed.
            chaos.leak.append(b"\x5a" * (chaos.leak_mb_per_sec * 1024 * 1024))


def burn_cpu(ms: float) -> None:
    """Consume `ms` of real CPU time on this thread."""
    end = time.thread_time() + ms / 1000
    x = 0
    while time.thread_time() < end:
        x += 1


# --------------------------------------------------------------------------- #
# Dependencies                                                                 #
# --------------------------------------------------------------------------- #

cache = redis.Redis(host=REDIS_HOST, db=0, socket_timeout=0.5, socket_connect_timeout=0.5)
control = redis.Redis(host=REDIS_HOST, db=2, socket_timeout=0.5, socket_connect_timeout=0.5)


class Pool:
    """Tiny Postgres connection pool with reconnect."""

    def __init__(self, dsn: str, size: int = 4) -> None:
        self.dsn = dsn
        self.free: queue.Queue[psycopg.Connection | None] = queue.Queue()
        for _ in range(size):
            self.free.put(None)

    @contextmanager
    def conn(self):
        c = self.free.get(timeout=5)
        try:
            if c is None or c.closed:
                c = psycopg.connect(self.dsn, autocommit=True, connect_timeout=3)
            yield c
        except psycopg.OperationalError:
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
            c = None
            raise
        finally:
            self.free.put(c)


db = Pool(PG_DSN) if PG_DSN else None


# --------------------------------------------------------------------------- #
# Workers                                                                      #
# --------------------------------------------------------------------------- #


def process_payment(c: psycopg.Connection) -> bool:
    row = c.execute(
        """
        UPDATE orders SET status = 'paid', paid_at = now()
        WHERE id = (
            SELECT id FROM orders WHERE status = 'new'
            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING id, amount_cents
        """
    ).fetchone()
    if row is None:
        return False
    # Payment signing work.
    hashlib.pbkdf2_hmac("sha256", str(row[0]).encode(), b"sentinel", 4000)
    return True


def process_notification(c: psycopg.Connection) -> bool:
    row = c.execute(
        """
        UPDATE orders SET notified = true
        WHERE id = (
            SELECT id FROM orders WHERE status = 'paid' AND notified = false
            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING id
        """
    ).fetchone()
    if row is None:
        return False
    # Rendering + handing the message to the (demo) mail relay.
    time.sleep(random.uniform(0.015, 0.035))
    return True


def worker_loop() -> None:
    handler = process_payment if SERVICE == "payment-worker" else process_notification
    failures = 0
    while True:
        started = time.perf_counter()
        try:
            with db.conn() as c:  # type: ignore[union-attr]
                did = handler(c)
            if not did:
                time.sleep(0.2)
                continue
            if chaos.latency_ms:
                time.sleep(chaos.latency_ms / 1000)
            recorder.record((time.perf_counter() - started) * 1000, True)
            failures = 0
        except Exception as exc:  # noqa: BLE001
            recorder.record((time.perf_counter() - started) * 1000, False)
            failures += 1
            if failures in (1, 10) or failures % 50 == 0:
                log.error("job failed: %s", exc)
            time.sleep(0.5)


# --------------------------------------------------------------------------- #
# App                                                                          #
# --------------------------------------------------------------------------- #

http: httpx.AsyncClient | None = None


async def poll_cpu_flag() -> None:
    while True:
        try:
            raw = await asyncio.to_thread(control.get, "chaos:cpu-burn-ms")
            value = int(raw) if raw else 0
            if value != chaos.cpu_burn_ms:
                if value:
                    log.warning("cpu pressure active: %sms of work per request", value)
                else:
                    log.info("cpu pressure cleared")
            chaos.cpu_burn_ms = value
        except Exception:
            pass
        await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global http
    threading.Thread(target=leak_loop, daemon=True).start()
    tasks: list[asyncio.Task] = []
    if IS_WORKER:
        for _ in range(2):
            threading.Thread(target=worker_loop, daemon=True).start()
    if SERVICE == "api-gateway":
        http = httpx.AsyncClient(timeout=5.0)
        tasks.append(asyncio.create_task(poll_cpu_flag()))
    log.info("%s started on :%s (pid %s)", SERVICE, PORT, os.getpid())
    yield
    for t in tasks:
        t.cancel()
    if http:
        await http.aclose()


app = FastAPI(title=SERVICE, lifespan=lifespan)

INTERNAL = ("/health", "/stats", "/chaos")


@app.middleware("http")
async def measure(request: Request, call_next):
    path = request.url.path
    if path.startswith(INTERNAL) or IS_WORKER:
        return await call_next(request)
    started = time.perf_counter()
    request.state.upstream_ms = 0.0
    request.state.upstream_error = False
    try:
        if chaos.latency_ms:
            await asyncio.sleep(chaos.latency_ms / 1000)
        if chaos.mixed_active():
            await asyncio.sleep(random.uniform(0.08, 0.16))
            await asyncio.to_thread(burn_cpu, 4)
            if random.random() < 0.03:
                raise HTTPException(status_code=500, detail="intermittent failure")
        if chaos.cpu_burn_ms:
            await asyncio.to_thread(burn_cpu, chaos.cpu_burn_ms)
        response = await call_next(request)
        status = response.status_code
    except HTTPException as exc:
        response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        status = exc.status_code
    except Exception as exc:  # noqa: BLE001
        log.error("unhandled error on %s: %s", path, exc)
        response = JSONResponse({"detail": "internal error"}, status_code=500)
        status = 500
    total = (time.perf_counter() - started) * 1000
    # The gateway reports its own processing time and its own failures, so an
    # upstream fault is attributed to the upstream service, not to the gateway.
    own_ms = max(0.0, total - getattr(request.state, "upstream_ms", 0.0))
    upstream_passthrough = getattr(request.state, "upstream_error", False)
    ok = status < 500 or upstream_passthrough
    recorder.record(own_ms, ok)
    if status >= 500 and not upstream_passthrough:
        log.error("%s %s -> %s (%.0fms)", request.method, path, status, total)
    return response


@app.get("/health")
def health():
    return {"status": "ok", "service": SERVICE}


@app.get("/stats")
def stats():
    return {
        "service": SERVICE,
        "pid": os.getpid(),
        "startedAt": STARTED_AT_MS,
        **recorder.snapshot(),
        "chaos": chaos.describe(),
    }


# ----- chaos ---------------------------------------------------------------- #


@app.post("/chaos/memory-leak")
def chaos_leak(mb_per_sec: int = 3):
    chaos.leak_mb_per_sec = max(1, min(16, mb_per_sec))
    chaos.leak_on = True
    log.warning("memory leak injected: +%sMB/s", chaos.leak_mb_per_sec)
    return {"ok": True}


@app.post("/chaos/latency")
def chaos_latency(ms: int = 650):
    chaos.latency_ms = max(0, min(5000, ms))
    log.warning("latency injected: +%sms per request", chaos.latency_ms)
    return {"ok": True}


@app.post("/chaos/mixed")
def chaos_mixed(seconds: int = 150):
    chaos.mixed_until = time.monotonic() + max(10, min(600, seconds))
    log.warning("mixed degradation injected for %ss", seconds)
    return {"ok": True}


@app.post("/chaos/crash")
def chaos_crash():
    log.error("fatal: unrecoverable worker state, exiting")

    def die() -> None:
        time.sleep(0.2)
        sys.stdout.flush()
        os._exit(1)

    threading.Thread(target=die, daemon=True).start()
    return {"ok": True}


@app.post("/chaos/reset")
def chaos_reset():
    chaos.leak_on = False
    chaos.leak.clear()
    chaos.latency_ms = 0
    chaos.mixed_until = 0.0
    log.info("chaos state cleared")
    return {"ok": True}


# ----- gateway -------------------------------------------------------------- #


async def proxy(request: Request, method: str, url: str, body: dict | None = None):
    assert http is not None
    started = time.perf_counter()
    try:
        r = await http.request(method, url, json=body)
    except httpx.HTTPError as exc:
        request.state.upstream_ms = (time.perf_counter() - started) * 1000
        log.error("upstream unreachable %s: %s", url, exc.__class__.__name__)
        raise HTTPException(status_code=502, detail="upstream unavailable")
    request.state.upstream_ms = (time.perf_counter() - started) * 1000
    if r.status_code >= 500:
        request.state.upstream_error = True
    return JSONResponse(r.json() if r.content else {}, status_code=r.status_code)


if SERVICE == "api-gateway":

    @app.post("/api/login")
    async def gw_login(request: Request):
        user = random.randint(1, 50)
        return await proxy(request, "POST", f"{AUTH_URL}/login", {"user": f"user{user}"})

    @app.get("/api/products/{pid}")
    async def gw_product(pid: int, request: Request):
        return await proxy(request, "GET", f"{ORDERS_URL}/products/{pid}")

    @app.post("/api/checkout")
    async def gw_checkout(request: Request):
        return await proxy(
            request,
            "POST",
            f"{ORDERS_URL}/orders",
            {"product": random.randint(1, 200), "qty": random.randint(1, 3)},
        )


# ----- auth ----------------------------------------------------------------- #

if SERVICE == "auth-service":

    @app.post("/login")
    def login(body: dict):
        name = str(body.get("user", "user1"))
        with db.conn() as c:  # type: ignore[union-attr]
            row = c.execute("SELECT id, salt FROM users WHERE name = %s", (name,)).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="unknown user")
        digest = hashlib.pbkdf2_hmac("sha256", name.encode(), row[1].encode(), 6000)
        return {"token": digest.hex()[:32], "user": row[0]}


# ----- orders --------------------------------------------------------------- #

if SERVICE == "orders-service":
    _cache_warned = 0.0

    def _cache_warn(msg: str) -> None:
        global _cache_warned
        now = time.monotonic()
        if now - _cache_warned > 5:
            _cache_warned = now
            log.warning(msg)

    @app.get("/products/{pid}")
    def product(pid: int):
        key = f"product:{pid}"
        try:
            hit = cache.get(key)
            if hit is not None:
                return json.loads(hit)
        except redis.RedisError as exc:
            _cache_warn(f"cache read failed: {exc}")
        with db.conn() as c:  # type: ignore[union-attr]
            row = c.execute(
                "SELECT id, name, price_cents FROM products WHERE id = %s", (pid,)
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="no such product")
        data = {"id": row[0], "name": row[1], "priceCents": row[2]}
        try:
            cache.set(key, json.dumps(data), ex=45)
        except redis.RedisError as exc:
            # Cache is best-effort: a full cache degrades hit rate, not the request.
            _cache_warn(f"cache write rejected: {exc}")
        return data

    @app.post("/orders")
    def create_order(body: dict):
        pid = int(body.get("product", 1))
        qty = int(body.get("qty", 1))
        with db.conn() as c:  # type: ignore[union-attr]
            row = c.execute(
                """
                INSERT INTO orders (product_id, qty, amount_cents)
                SELECT id, %s, price_cents * %s FROM products WHERE id = %s
                RETURNING id
                """,
                (qty, qty, pid),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="no such product")
        return {"order": row[0], "status": "new"}
