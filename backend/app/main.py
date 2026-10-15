"""SentinelOps API (FastAPI).

REST endpoints mirror src/lib/api/sentinel-client.ts. Live state is pushed on
/ws as a snapshot followed by patches shaped like the frontend Zustand store.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth, config
from .catalog import POLICIES, SCENARIOS
from .core import Core

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("sentinel.api")

if auth.enabled():
    if len(config.ADMIN_PASSWORD) < 12:
        raise SystemExit("SENTINEL_ADMIN_PASSWORD must be at least 12 characters")
    if not config.SESSION_SECRET:
        config.SESSION_SECRET = auth.random_secret()
        log.warning("SENTINEL_SESSION_SECRET not set; sessions will not survive a restart")
else:
    log.warning("Auth disabled (no SENTINEL_ADMIN_PASSWORD) — keep the API bound to 127.0.0.1")

core = Core()
limiter = auth.LoginLimiter()

PUBLIC_PATHS = {"/api/healthz", "/api/auth/login", "/api/auth/me", "/api/auth/logout"}
WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    await core.start()
    log.info("SentinelOps control plane started")
    yield
    await core.stop()


app = FastAPI(
    title="SentinelOps API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None if auth.enabled() else "/docs",
    redoc_url=None,
    openapi_url=None if auth.enabled() else "/openapi.json",
)


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if request.method in WRITE_METHODS:
        origin = request.headers.get("origin")
        if origin and origin not in config.CORS_ORIGINS:
            return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
    if auth.enabled() and path.startswith("/api/") and path not in PUBLIC_PATHS:
        if auth.verify(request.cookies.get(auth.COOKIE)) is None:
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["content-type", "accept"],
)


# ---------------------------------------------------------------------- auth


class LoginInput(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(body: LoginInput, request: Request, response: Response):
    if not auth.enabled():
        return {"user": None, "authRequired": False}
    client = request.client.host if request.client else "unknown"
    if limiter.blocked(client):
        raise HTTPException(status_code=429, detail="Too many failed logins — try again in a few minutes")
    if not auth.check_credentials(body.username, body.password):
        limiter.fail(client)
        log.warning("failed login for %r from %s", body.username, client)
        raise HTTPException(status_code=401, detail="Wrong username or password")
    limiter.clear(client)
    response.set_cookie(
        auth.COOKIE,
        auth.issue(body.username),
        max_age=config.SESSION_TTL_SEC,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    log.info("login: %s from %s", body.username, client)
    return {"user": body.username, "authRequired": True}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request):
    if not auth.enabled():
        return {"user": None, "authRequired": False}
    user = auth.verify(request.cookies.get(auth.COOKIE))
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"user": user, "authRequired": True}


class ChaosInjectInput(BaseModel):
    scenario: Literal[
        "memory-leak", "unknown-anomaly", "cpu-spike", "service-crash", "latency-injection", "cache-saturation"
    ]


class RemediationExecuteInput(BaseModel):
    policyId: str
    serviceId: str
    incidentId: str | None = None
    dryRun: bool | None = None


# --------------------------------------------------------------------- reads


@app.get("/api/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/status")
def status():
    backend = core.hub.get("backend", {})
    return {"ok": True, **backend}


@app.get("/api/state")
def state():
    return core.hub.snapshot()


@app.get("/api/system/health")
def system_health():
    return core.hub.get("cluster")


@app.get("/api/services")
def services():
    return core.hub.get("services", [])


@app.get("/api/services/{service_id}/metrics")
def service_metrics(service_id: str):
    svc = next((s for s in core.hub.get("services", []) if s["id"] == service_id), None)
    samples = list(core.hub.histories.get(service_id, []))
    return {"service": svc, "samples": samples}


@app.get("/api/incidents")
def incidents():
    return sorted(core.incidents, key=lambda i: i["detectedAt"], reverse=True)


@app.get("/api/incidents/{incident_id}")
def incident(incident_id: str):
    return next((i for i in core.incidents if i["id"] == incident_id), None)


@app.get("/api/logs")
def logs(
    level: Literal["DEBUG", "INFO", "WARN", "ERROR"] | None = None,
    service: str | None = None,
    search: str | None = None,
    limit: int | None = Query(default=None, ge=1, le=1000),
):
    items = list(core.hub.rings["logs"])
    if level:
        items = [entry for entry in items if entry["level"] == level]
    if service:
        items = [entry for entry in items if entry["service"] == service]
    if search:
        q = search.lower()
        items = [entry for entry in items if q in entry["message"].lower()]
    if limit:
        items = items[-limit:]
    return items


@app.get("/api/anomalies")
def anomalies():
    a = core.hub.get("anomaly")
    return [a] if a else []


@app.get("/api/remediation/policies")
def policies():
    return POLICIES


@app.get("/api/experiments")
def experiments():
    return core.experiments


@app.get("/api/scenarios")
def scenarios():
    return SCENARIOS


@app.get("/api/ml/status")
def ml_status():
    model = core.hub.get("model", {})
    research = core.hub.get("research", {})
    anomaly = core.hub.get("anomaly", {}) or {}
    return {
        "model": "Isolation Forest",
        "status": model.get("status", "training"),
        "baselineWindowHours": core.settings["baselineWindowHours"],
        "anomalyScore": anomaly.get("score", 0.0),
        "detectors": core.hub.get("detectors", []),
        "contributions": anomaly.get("contributions", []),
        "research": {
            k: research.get(k)
            for k in ("precision", "recall", "f1", "falsePositiveRate", "mttdImprovement", "mttrImprovement")
        },
        "services": core.detector_report(),
    }


@app.get("/api/settings")
def get_settings():
    return core.settings


@app.get("/api/research/export")
def research_export():
    """Raw records for offline evaluation (scripts/evaluate.py)."""
    return {
        "exportedAt": int(time.time() * 1000),
        "experiments": core.experiments,
        "incidents": core.incidents,
        "detections": core.detections,
        "evalCounters": core.eval_counters,
        "config": {
            "mlFireScore": config.ML_FIRE_SCORE,
            "mlMinEffectSigma": config.ML_MIN_EFFECT_Z,
            "mlConsecutiveToFire": config.ML_CONSECUTIVE_TO_FIRE,
            "thresholdConsecutiveToFire": config.CONSECUTIVE_TO_FIRE,
            "warmupSamples": config.WARMUP_SAMPLES,
            "decisionThreshold": core.settings.get("decisionThreshold"),
        },
    }


# -------------------------------------------------------------------- writes


@app.post("/api/chaos/inject")
async def chaos_inject(body: ChaosInjectInput):
    return await core.inject(body.scenario)


@app.post("/api/remediation/execute")
async def remediation_execute(body: RemediationExecuteInput):
    try:
        return await core.manual_execute(body.policyId, body.serviceId, body.incidentId, body.dryRun)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/settings")
@app.post("/api/settings")
async def patch_settings(body: dict):
    return await core.update_settings(body)


@app.post("/api/system/reset")
async def system_reset():
    return await core.reset()


# ----------------------------------------------------------------- websocket


@app.websocket("/ws")
async def ws(socket: WebSocket):
    origin = socket.headers.get("origin")
    if origin and origin not in config.CORS_ORIGINS:
        await socket.close(code=1008)
        return
    if auth.enabled() and auth.verify(socket.cookies.get(auth.COOKIE)) is None:
        await socket.close(code=4401)
        return
    await socket.accept()
    await core.hub.connect(socket)
    try:
        while True:
            msg = await socket.receive_json()
            if isinstance(msg, dict) and msg.get("type") == "resync":
                await core.hub.send_snapshot(socket)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        core.hub.disconnect(socket)
