"""
Steady synthetic traffic against the demo gateway.

Open-loop: requests are scheduled at a fixed average rate whether or not earlier
ones finished, like real users. Keep-alive is disabled so every request resolves
the gateway name again, which spreads load across scaled-out replicas.
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
import time

import httpx

TARGET = os.environ.get("TARGET", "http://api-gateway:8080")
RATE = float(os.environ.get("RATE", "15"))
MAX_IN_FLIGHT = int(os.environ.get("MAX_IN_FLIGHT", "64"))

stats = {"ok": 0, "err": 0, "dropped": 0}


def log(level: str, msg: str) -> None:
    print(f"{level} {msg}", flush=True)


async def one(client: httpx.AsyncClient) -> None:
    roll = random.random()
    try:
        if roll < 0.25:
            r = await client.post(f"{TARGET}/api/login")
        elif roll < 0.8:
            r = await client.get(f"{TARGET}/api/products/{random.randint(1, 200)}")
        else:
            r = await client.post(f"{TARGET}/api/checkout")
        if r.status_code >= 500:
            stats["err"] += 1
        else:
            stats["ok"] += 1
    except httpx.HTTPError:
        stats["err"] += 1


async def main() -> None:
    limits = httpx.Limits(max_keepalive_connections=0, max_connections=MAX_IN_FLIGHT)
    in_flight: set[asyncio.Task] = set()
    last_report = time.monotonic()
    async with httpx.AsyncClient(timeout=5.0, limits=limits) as client:
        log("INFO", f"load generator started: {RATE} req/s against {TARGET}")
        while True:
            await asyncio.sleep(random.expovariate(RATE))
            if len(in_flight) >= MAX_IN_FLIGHT:
                stats["dropped"] += 1
            else:
                task = asyncio.create_task(one(client))
                in_flight.add(task)
                task.add_done_callback(in_flight.discard)
            now = time.monotonic()
            if now - last_report >= 30:
                level = "WARNING" if stats["err"] or stats["dropped"] else "INFO"
                log(
                    level,
                    f"last 30s: {stats['ok']} ok, {stats['err']} failed, {stats['dropped']} dropped",
                )
                stats.update(ok=0, err=0, dropped=0)
                last_report = now


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
