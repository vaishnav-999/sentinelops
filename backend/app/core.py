"""SentinelOps control plane.

One asyncio loop (1 Hz) owns everything:
  collect (Docker stats, /stats probes, Redis INFO, Postgres) ->
  detect (Isolation Forest + static rules) ->
  incident pipeline (diagnose -> policy -> guardrails -> real action -> verify) ->
  publish (state hub -> WebSocket patches in the frontend store's shape).

Chaos runs only inject a real fault and record timings; the incident pipeline
is triggered by real detection, never by the script.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import time
from collections import deque

import redis.asyncio as aioredis
from redis.exceptions import OutOfMemoryError, ResponseError

from . import config, evaluation
from .catalog import (
    DEFAULT_SETTINGS,
    FAULT_POLICY,
    HTTP_SERVICES,
    INFRA_EDGES,
    INFRA_NODES,
    POLICIES,
    POLICY_BY_ID,
    SCENARIOS,
    SERVICE_BY_ID,
    SERVICE_IDS,
    SERVICES,
    SETTINGS_TYPES,
)
from .detector import ServiceDetector, Verdict
from .diagnoser import diagnose
from .docker_io import DockerWatcher
from .hub import Hub
from .persistence import Store
from .probes import Prober
from .trust import TrustLedger

log = logging.getLogger("sentinel.core")

AUTO_HEAL_STEPS = ["injected", "detected", "analyzing", "policy_check", "remediating", "verifying", "resolved"]
ESCALATE_STEPS = ["injected", "detected", "analyzing", "policy_check", "escalated"]
STEP_PHASE = {
    "injected": "injecting",
    "detected": "detected",
    "analyzing": "diagnosing",
    "policy_check": "policy_check",
    "remediating": "remediating",
    "verifying": "verifying",
    "resolved": "resolved",
    "escalated": "escalated",
}
STAGES = ["detected", "analyzed", "policy_check", "remediation", "verification", "resolved"]
STATUS_PENALTY = {"healthy": 0, "recovering": 3, "degraded": 9, "critical": 20}

FAULT_TITLE = {
    "service_crash": "Service crash",
    "memory_leak": "Memory leak",
    "cpu_saturation": "CPU saturation",
    "latency_spike": "Latency degradation",
    "cache_saturation": "Cache saturation",
    "unknown": "Unclassified anomaly",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def r1(v: float) -> float:
    return round(float(v), 1)


class Core:
    def __init__(self) -> None:
        self.hub = Hub()
        self.db = Store(config.SENTINEL_DB_DSN)
        self.watcher: DockerWatcher | None = None
        self.prober = Prober()
        self.redis_ctl = aioredis.Redis(host=config.REDIS_HOST, db=2, socket_timeout=2, socket_connect_timeout=2)
        self.redis_cache = aioredis.Redis(host=config.REDIS_HOST, db=0, socket_timeout=5, socket_connect_timeout=2)

        self.detectors = {sid: ServiceDetector(sid) for sid in SERVICE_IDS}
        self.windows: dict[str, deque] = {sid: deque(maxlen=60) for sid in SERVICE_IDS}
        self.latest: dict[str, dict] = {}
        self.verdicts: dict[str, Verdict] = {}
        self.fired_at: dict[str, dict[str, int | None]] = {sid: {"ml": None, "threshold": None} for sid in SERVICE_IDS}
        self.uptime: dict[str, list[int]] = {sid: [0, 0] for sid in SERVICE_IDS}
        self.started_at: dict[str, int] = {}
        self.hit_baseline: float | None = None

        self.settings = dict(DEFAULT_SETTINGS)
        self.guardrails: dict[str, list[int]] = {}
        self.incidents: list[dict] = []
        self.executions: list[dict] = []
        self.experiments: list[dict] = []
        self.detections: list[dict] = []
        self.counters = {"incident": 1001, "execution": 1, "experiment": 1}
        self.eval_counters = {"healthyWindows": 0, "fpWindows": 0}
        self._minute_fp: set[str] = set()
        self._minute_started = time.monotonic()

        self.pipelines: dict[str, asyncio.Task] = {}
        self.pipeline_order: list[str] = []
        self.status_override: dict[str, str] = {}
        self.container_override: dict[str, str] = {}
        self.last_closed: dict[str, int] = {}

        self.run: dict | None = None
        self.run_task: asyncio.Task | None = None
        self.last_run_end = 0

        self.island = "operational"
        self.island_started: int | None = None
        self.island_changed = now_ms()
        self.recovered_since: int | None = None
        self.scenario_phase = "idle"
        self.chaos_run: dict | None = None
        self.diagnosis: dict | None = None

        self.seq = 0
        self.ticks = 0
        self.last_tick_at = 0
        self.stall_until = 0
        self.stats_ok: dict[str, bool] = {}
        self.systemic_until = 0
        self.escalated_at: dict[str, int] = {}
        # Detections held by the host-wide guard or attributed to a dependency;
        # re-evaluated every tick while the detector stays fired.
        self.deferred: dict[str, str] = {}
        self.trust = TrustLedger()
        self._calm_at = 0
        self._calm_index = 0
        self._loop_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ================================================================ startup

    async def start(self) -> None:
        await asyncio.to_thread(self.db.init)
        await asyncio.to_thread(self._load)
        try:
            self.watcher = await asyncio.to_thread(DockerWatcher)
        except Exception as exc:  # noqa: BLE001
            log.error("Docker unavailable: %s", exc)
            self.watcher = None
        self.hub.set(
            infraEdges=INFRA_EDGES,
            policies=POLICIES,
            selectedExecutionId=self.executions[-1]["id"] if self.executions else None,
        )
        self._publish()
        self.stall_until = now_ms() + config.BOOT_GRACE_SEC * 1000
        self._loop_task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        await self.prober.close()

    def _load(self) -> None:
        settings = self.db.get("settings")
        if isinstance(settings, dict):
            for k, v in settings.items():
                if k in SETTINGS_TYPES and isinstance(v, SETTINGS_TYPES[k]):
                    self.settings[k] = v
        guard = self.db.get("guardrails")
        if isinstance(guard, dict):
            self.guardrails = {k: list(v) for k, v in guard.items()}
        counters = self.db.get("counters")
        if isinstance(counters, dict):
            self.counters.update({k: int(v) for k, v in counters.items() if k in self.counters})
        ev = self.db.get("eval")
        if isinstance(ev, dict):
            self.eval_counters.update({k: int(v) for k, v in ev.items() if k in self.eval_counters})
        self.trust.restore(self.db.get("trust"))
        self.incidents = self.db.load("incident", 200)
        self.executions = self.db.load("execution", 50)
        self.experiments = self.db.load("experiment", 100)
        self.detections = self.db.load("detection", 5000)
        for sid, d in self.detectors.items():
            d.restore_baseline(self.db.get(f"baseline:{sid}"))
        t = now_ms()
        for inc in self.incidents:
            if inc.get("status") not in ("resolved", "escalated"):
                inc["status"] = "escalated"
                inc["outcomeLabel"] = "Interrupted by backend restart"
                self.db.upsert("incident", inc["id"], inc["detectedAt"], inc)
        for exe in self.executions:
            if exe.get("outcome") == "in_progress":
                exe["outcome"] = "failed"
                exe["completedAt"] = t
                self.db.upsert("execution", exe["id"], exe["startedAt"], exe)
        for e in self.experiments:
            if e.get("outcome") == "running":
                e["outcome"] = "cancelled"
                self.db.upsert("experiment", e["id"], e["injectedAt"], e)

    # ================================================================== loop

    async def _loop(self) -> None:
        loop = asyncio.get_running_loop()
        next_at = loop.time()
        while True:
            next_at += config.TICK_SEC
            try:
                async with self._lock:
                    await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("tick failed")
            try:
                await self.hub.flush()
            except Exception:  # noqa: BLE001
                log.exception("flush failed")
            delay = next_at - loop.time()
            if delay < 0:
                next_at = loop.time()
                delay = 0
            await asyncio.sleep(delay)

    def _next(self, prefix: str) -> str:
        self.seq += 1
        return f"{prefix}-{self.seq}"

    async def _tick(self) -> None:
        t = now_ms()
        self.ticks += 1
        if self.last_tick_at and t - self.last_tick_at > config.STALL_GAP_SEC * 1000:
            gap = (t - self.last_tick_at) / 1000
            self.stall_until = t + config.STARTUP_GRACE_SEC * 1000
            log.warning("telemetry gap of %.1fs; holding detection for %ss", gap, config.STARTUP_GRACE_SEC)
            self._event(
                "telemetry",
                f"Telemetry gap of {gap:.0f}s (host paused or overloaded) — detection held for "
                f"{config.STARTUP_GRACE_SEC}s",
                "warn",
            )
        self.last_tick_at = t

        if self.watcher is not None:
            await asyncio.to_thread(self.watcher.refresh)
            containers, stats = self.watcher.snapshot()
        else:
            containers, stats = {}, {}

        app_containers = [c for c in containers.values() if c["running"] and c["service"] in HTTP_SERVICES]
        probes, redis_s, pg_tpm = await asyncio.gather(
            self.prober.app_stats(app_containers),
            self.prober.redis_stats(),
            self.prober.postgres_tpm(),
        )

        by_service: dict[str, list[dict]] = {}
        for c in containers.values():
            by_service.setdefault(c["service"], []).append(c)

        services = []
        edges: list[tuple[str, str, Verdict]] = []
        for svc in SERVICES:
            sid = svc["id"]
            conts = by_service.get(sid, [])
            metrics, running, probe_ok, primary = self._service_metrics(sid, conts, stats, probes, redis_s)
            self.latest[sid] = {**metrics, "running": running, "probeOk": probe_ok}
            self.windows[sid].append(metrics)

            started = primary.get("startedAt") if primary else None
            if started and self.started_at.get(sid) not in (None, started):
                self.detectors[sid].container_restarted()
            if started:
                self.started_at[sid] = started
            in_grace = bool(running and started and (t - started) < config.STARTUP_GRACE_SEC * 1000)
            in_grace = in_grace or t < self.stall_until or (running and not self.stats_ok.get(sid, False))
            eligible = (
                running
                and probe_ok
                and self.run is None
                and t - self.last_run_end > 60_000
                and sid not in self.pipelines
                and t >= self.systemic_until
            )
            verdict = self.detectors[sid].observe(metrics, t / 1000, eligible, in_grace)
            if not self.settings["anomalyScan"]:
                verdict.ml_fired = False
                verdict.ml_edge = False
            self.verdicts[sid] = verdict

            if sid == "redis-cache" and eligible and metrics.get("hitRate") is not None and not verdict.ml_fired:
                hr = metrics["hitRate"]
                self.hit_baseline = hr if self.hit_baseline is None else self.hit_baseline * 0.98 + hr * 0.02

            up = running and probe_ok
            self.uptime[sid][0] += 1 if up else 0
            self.uptime[sid][1] += 1

            if not verdict.ml_fired:
                self.fired_at[sid]["ml"] = None
            if not verdict.thr_fired:
                self.fired_at[sid]["threshold"] = None
            if verdict.ml_edge:
                edges.append((sid, "ml", verdict))
            if verdict.thr_edge:
                edges.append((sid, "threshold", verdict))

            status = self._status(sid, running, metrics, verdict)
            services.append(self._service_doc(svc, status, metrics, primary, started, t))

        self._check_systemic(t)
        for sid, kind, verdict in edges:
            self._on_detect(sid, kind, t, verdict)
        edge_sids = {sid for sid, _, _ in edges}
        for sid, kind in list(self.deferred.items()):
            v = self.verdicts.get(sid)
            if v is None or not (v.ml_fired or v.thr_fired):
                self.deferred.pop(sid, None)
            elif sid not in edge_sids:
                self._maybe_open(sid, kind, t, v)

        self._count_windows()
        if self.trust.expire(t):
            self._save_trust()

        # Island returns to operational 8 s after "recovered".
        if self.recovered_since is not None and t - self.recovered_since >= 8000 and not self.pipelines:
            self.recovered_since = None
            self._set_island("operational")

        open_incidents = sum(1 for i in self.incidents if i["status"] not in ("resolved", "escalated"))
        cluster = self._cluster(t, services, open_incidents)

        self.hub.set(services=services, cluster=cluster)
        for s in services:
            m = s["metrics"]
            self.hub.append_history(
                s["id"],
                {"t": t, "cpu": m["cpu"], "memory": m["memory"], "latencyP95": m["latencyP95"],
                 "errorRate": m["errorRate"], "throughput": m["throughput"]},
            )
        self.hub.append("clusterHistory", cluster)
        if self.ticks % 5 == 0:
            self.hub.append("clusterTrail", cluster)

        self.hub.set(
            containers=self._containers_doc(containers, stats, probes, redis_s),
            infraNodes=self._nodes_doc(services, containers, stats, pg_tpm, t),
        )

        focus = self._focus()
        anomaly, detectors = self._anomaly_doc(focus, t)
        self.hub.append("anomalyHistory", {"t": t, "score": anomaly["score"]})
        self.hub.set(anomaly=anomaly, detectors=detectors)

        if self.watcher is not None:
            for entry in self.watcher.drain_logs(250):
                self.hub.append("logs", {"id": self._next("log"), **entry})

        if not self.pipelines and self.run is None and t >= self._calm_at:
            self._calm_event(services)
            self._calm_at = t + 5000

        self._publish()

    # ============================================================ telemetry

    def _service_metrics(self, sid, conts, stats, probes, redis_s):
        running_conts = [c for c in conts if c["running"]]
        primary = next((c for c in conts if not c["replica"]), conts[0] if conts else None)
        running = bool(running_conts)
        prev = self.windows[sid][-1] if self.windows[sid] else None

        cpus = [stats[c["id"]]["cpu"] for c in running_conts if c["id"] in stats]
        mems = [stats[c["id"]]["memory"] for c in running_conts if c["id"] in stats]
        # Docker's first stats sample lags a fresh container by a second or two;
        # carry the last reading rather than report a false drop to zero.
        cpu = sum(cpus) / len(cpus) if cpus else (prev or {}).get("cpu", 0.0)
        mem = sum(mems) / len(mems) if mems else (prev or {}).get("memory", 0.0)
        self.stats_ok[sid] = len(cpus) == len(running_conts)

        if sid == "redis-cache":
            probe_ok = redis_s is not None
            if probe_ok:
                hit = redis_s["hitRate"]
                metrics = {
                    "cpu": r1(cpu),
                    "memory": r1(redis_s["memory"]),
                    "latencyP95": r1(redis_s["latencyP95"]),
                    "errorRate": round(redis_s["errorRate"], 2),
                    "throughput": int(redis_s["throughput"]),
                    "hitRate": r1(hit) if hit is not None else (prev or {}).get("hitRate", 0.0),
                }
            else:
                metrics = {"cpu": r1(cpu), "memory": r1(mem), "latencyP95": (prev or {}).get("latencyP95", 0.0),
                           "errorRate": 100.0, "throughput": 0, "hitRate": 0.0}
        else:
            ok = [probes.get(c["id"]) for c in running_conts if probes.get(c["id"])]
            probe_ok = bool(ok)
            if ok:
                count = sum(p["count"] for p in ok)
                errors = sum(p["errors"] for p in ok)
                p95 = (
                    sum(p["p95"] * p["count"] for p in ok) / count if count else max(p["p95"] for p in ok)
                )
                metrics = {
                    "cpu": r1(cpu),
                    "memory": r1(mem),
                    "latencyP95": round(p95) if p95 >= 10 else r1(p95),
                    "errorRate": round(errors / count * 100, 2) if count else 0.0,
                    "throughput": int(sum(p["throughput"] for p in ok)),
                }
            else:
                metrics = {"cpu": r1(cpu), "memory": r1(mem), "latencyP95": (prev or {}).get("latencyP95", 0),
                           "errorRate": 100.0, "throughput": 0}
        if not running:
            metrics.update(cpu=0.0, memory=0.0, errorRate=100.0, throughput=0)
        return metrics, running, probe_ok, primary

    def _status(self, sid, running, metrics, verdict: Verdict) -> str:
        if not running:
            return "critical"
        if sid in self.status_override:
            return self.status_override[sid]
        if verdict.thr_fired or metrics["errorRate"] > 20:
            return "critical"
        if verdict.ml_fired:
            return "degraded"
        return "healthy"

    def _baseline_metrics(self, sid: str, current: dict) -> dict:
        base = self.detectors[sid].baseline()
        if base is None:
            out = {k: current[k] for k in ("cpu", "memory", "latencyP95", "errorRate", "throughput")}
        else:
            out = {
                "cpu": r1(base["cpu"]),
                "memory": r1(base["memory"]),
                "latencyP95": round(base["latencyP95"]) if base["latencyP95"] >= 10 else r1(base["latencyP95"]),
                "errorRate": round(base["errorRate"], 2),
                "throughput": int(round(base["throughput"])),
            }
        if sid == "redis-cache":
            out["hitRate"] = r1(self.hit_baseline) if self.hit_baseline is not None else current.get("hitRate", 0.0)
        return out

    def _service_doc(self, svc, status, metrics, primary, started, t) -> dict:
        sid = svc["id"]
        up, total = self.uptime[sid]
        return {
            "id": sid,
            "name": svc["name"],
            "kind": svc["kind"],
            "status": status,
            "containerId": primary["short"] if primary else "",
            "image": primary["image"] if primary else "",
            "port": svc["port"],
            "uptimePct": round(up / total * 100, 3) if total else 100.0,
            "startedAt": started or t,
            "throughputUnit": svc["throughputUnit"],
            "metrics": metrics,
            "baseline": self._baseline_metrics(sid, metrics),
        }

    def _cluster(self, t, services, critical_incidents) -> dict:
        n = len(services) or 1
        penalty = sum(STATUS_PENALTY[s["status"]] + 0.8 * s["metrics"]["errorRate"] for s in services)
        return {
            "t": t,
            "cpu": r1(sum(s["metrics"]["cpu"] for s in services) / n),
            "memory": r1(sum(s["metrics"]["memory"] for s in services) / n),
            "latencyP95": round(sum(s["metrics"]["latencyP95"] for s in services) / n),
            "errorRate": round(sum(s["metrics"]["errorRate"] for s in services) / n, 2),
            "requestsPerMin": int(sum(s["metrics"]["throughput"] for s in services if s["throughputUnit"] == "rpm")),
            "uptimePct": round(sum(s["uptimePct"] for s in services) / n, 3),
            "healthScore": r1(max(0.0, min(100.0, 100 - penalty))),
            "servicesOnline": sum(1 for s in services if s["status"] != "critical"),
            "servicesTotal": len(services),
            "criticalIncidents": critical_incidents,
        }

    def _containers_doc(self, containers, stats, probes, redis_s) -> list[dict]:
        docs = []
        for c in sorted(containers.values(), key=lambda x: (x["service"], x["name"])):
            st = stats.get(c["id"])
            if c["service"] in self.container_override and not c["replica"]:
                status = self.container_override[c["service"]]
            elif c["status"] == "running":
                status = "unhealthy" if c["health"] == "unhealthy" else "running"
            elif c["status"] == "restarting":
                status = "restarting"
            else:
                status = "stopped"
            doc = {
                "id": c["short"],
                "name": c["name"],
                "image": c["image"],
                "status": status,
                "cpu": st["cpu"] if st and c["running"] else 0.0,
                "memory": st["memory"] if st and c["running"] else 0.0,
                "createdAt": c["createdAt"] or now_ms(),
            }
            if c["service"] in SERVICE_BY_ID:
                doc["serviceId"] = c["service"]
                doc["port"] = SERVICE_BY_ID[c["service"]]["port"]
            elif c["service"] == "postgres":
                doc["port"] = 5432
            p = probes.get(c["id"])
            if p:
                doc["requests"] = int(p["throughput"])
            elif c["service"] == "redis-cache" and redis_s:
                doc["requests"] = int(redis_s["throughput"])
            if st and c["running"]:
                doc["heartbeatAt"] = int(st["t"] * 1000)
            docs.append(doc)
        return docs

    def _nodes_doc(self, services, containers, stats, pg_tpm, t) -> list[dict]:
        by_id = {s["id"]: s for s in services}
        pg = next((c for c in containers.values() if c["service"] == "postgres"), None)
        nodes = []
        for n in INFRA_NODES:
            node = copy.deepcopy(n)
            if n["kind"] == "internet":
                nodes.append(node)
                continue
            svc = by_id.get(n.get("serviceId", ""))
            if svc:
                node["status"] = svc["status"]
                node["metrics"] = {
                    "cpu": svc["metrics"]["cpu"],
                    "memory": svc["metrics"]["memory"],
                    "requests": int(svc["metrics"]["throughput"]),
                }
                node["heartbeatAt"] = t if svc["status"] != "critical" else None
                node["meta"] = {"port": svc["port"], "containerId": svc["containerId"], "image": svc["image"]}
            elif n["id"] == "postgres":
                st = stats.get(pg["id"]) if pg else None
                running = bool(pg and pg["running"])
                node["status"] = "healthy" if running else "critical"
                node["metrics"] = {
                    "cpu": st["cpu"] if st else 0.0,
                    "memory": st["memory"] if st else 0.0,
                    "requests": int(pg_tpm),
                }
                node["heartbeatAt"] = t if running else None
                node["meta"] = {"port": 5432, "containerId": pg["short"] if pg else "", "image": pg["image"] if pg else ""}
            if node.get("heartbeatAt") is None:
                node.pop("heartbeatAt", None)
            nodes.append(node)
        return nodes

    # ============================================================ detection

    def _focus(self) -> str:
        if self.run is not None:
            return self.run["target"]
        if self.pipeline_order:
            return self.pipeline_order[-1]
        best, score = SERVICE_IDS[0], -1.0
        for sid, v in self.verdicts.items():
            if v.score > score:
                best, score = sid, v.score
        return best

    def _anomaly_doc(self, focus: str, t: int) -> tuple[dict, list[dict]]:
        v = self.verdicts.get(focus)
        trained = sum(1 for d in self.detectors.values() if d.trained)
        score = v.score if v else 0.0
        if score >= config.ML_FIRE_SCORE:
            baseline = "abnormal"
        elif score >= 0.4:
            baseline = "elevated"
        else:
            baseline = "normal"
        anomaly: dict = {"score": score, "baseline": baseline}
        if trained == 0:
            samples = min(len(d.healthy) for d in self.detectors.values())
            anomaly["note"] = f"Learning healthy baseline — {samples}/{config.WARMUP_SAMPLES} samples."
        elif baseline == "normal":
            anomaly["note"] = "No abnormal behaviour detected."
        else:
            anomaly["note"] = f"{'Abnormal' if baseline == 'abnormal' else 'Elevated'} behaviour on {focus}."
        if baseline != "normal" and v:
            anomaly["serviceId"] = focus
            if self.fired_at[focus]["ml"]:
                anomaly["detectedAt"] = self.fired_at[focus]["ml"]
            anomaly["contributions"] = v.contributions

        scn = SCENARIOS[self.run["scenarioId"]] if self.run else None
        thr: dict = {
            "kind": "threshold",
            "label": "Static threshold rule",
            "fired": bool(v and v.thr_fired),
            "firedAt": self.fired_at[focus]["threshold"],
        }
        if scn:
            thr["value"] = scn["threshold"]
            thr["detail"] = scn["thresholdLabel"]
        elif v and v.thr_rule:
            thr["detail"] = f"{v.thr_rule} on {focus}"
        else:
            thr["detail"] = "cpu > 85% · memory > 90% · p95 > 500 ms · error rate > 5%"
        ml = {
            "kind": "ml",
            "label": "Isolation Forest",
            "fired": bool(v and v.ml_fired),
            "firedAt": self.fired_at[focus]["ml"],
            "value": score,
        }
        if not self.detectors[focus].trained:
            ml["detail"] = "Learning baseline"
        return anomaly, [thr, ml]

    def _on_detect(self, sid: str, kind: str, t: int, verdict: Verdict) -> None:
        self.fired_at[sid][kind] = t
        run = self.run
        run_id = None
        if run is not None:
            run_id = run["id"]
        elif t - self.last_run_end < 60_000:
            run_id = "post-run"

        if run is not None and run.get("injectedAt") and run["target"] == sid:
            exp = self._experiment(run["id"])
            sec = round((t - run["injectedAt"]) / 1000, 1)
            if exp is not None:
                field = "mlDetectedAt" if kind == "ml" else "thresholdDetectedAt"
                if exp[field] is None:
                    exp[field] = t
                    self.db.upsert("experiment", exp["id"], exp["injectedAt"], exp)
                    if self.chaos_run and self.chaos_run["runId"] == run["id"]:
                        key = "mlDetectedSec" if kind == "ml" else "thresholdDetectedSec"
                        self.chaos_run[key] = sec

        det = {"id": self._next("det"), "kind": kind, "serviceId": sid, "t": t, "runId": run_id,
               "score": verdict.score, "rule": verdict.thr_rule}
        self.detections.append(det)
        self.detections = self.detections[-5000:]
        self.db.upsert("detection", det["id"] + f"-{t}", t, det)
        if kind == "ml" and run_id is None:
            self._minute_fp.add(sid)

        if kind == "ml":
            self._event("anomaly", f"Isolation Forest flagged {sid} — score {verdict.score:.2f}", "warn", sid)
        else:
            self._event("anomaly", f"Threshold rule fired — {verdict.thr_rule} on {sid}", "warn", sid)
        self._maybe_open(sid, kind, t, verdict)

    def _maybe_open(self, sid: str, kind: str, t: int, verdict: Verdict) -> None:
        """Open an incident unless the degradation is already explained.

        Held or attributed detections stay deferred, so a service that is still
        degraded after its dependency settles (or the host-wide hold lifts) gets
        its own incident instead of being silently dropped.
        """
        if sid in self.pipelines:
            self.deferred.pop(sid, None)
            return
        if t - self.last_closed.get(sid, 0) < 15_000:
            self.deferred.pop(sid, None)
            return
        if t < self.systemic_until:
            self.deferred[sid] = kind
            return
        cause = self._dependency_cause(sid, t)
        if cause is not None:
            if sid not in self.deferred:
                self._event(
                    "anomaly",
                    f"{sid} degradation attributed to {cause} — no separate incident opened",
                    "info",
                    sid,
                )
                self._record_impact(cause, sid, kind, t)
            self.deferred[sid] = kind
            return
        self.deferred.pop(sid, None)
        task = asyncio.create_task(self._pipeline(sid, kind, verdict))
        self.pipelines[sid] = task
        self.pipeline_order.append(sid)

    def _record_impact(self, cause: str, sid: str, kind: str, t: int) -> None:
        """Blast radius: a symptom on a caller is charged to the root incident,
        and the incident (plus action) it would otherwise have opened is counted
        as suppressed."""
        window = config.ESCALATION_MEMORY_SEC * 1000
        inc = next((i for i in reversed(self.incidents)
                    if i["serviceId"] == cause and t - i["detectedAt"] < window), None)
        if inc is None:
            return
        impact = inc.setdefault("impact", [])
        if any(x["serviceId"] == sid for x in impact):
            return
        impact.append({"serviceId": sid, "at": t, "signal": kind,
                       "metrics": self._snapshot_metrics(sid)})
        self._save_incident(inc)

    def detector_report(self) -> list[dict]:
        """Per-service detector state, for inspection via /api/ml/status."""
        out = []
        for sid, d in self.detectors.items():
            v = self.verdicts.get(sid)
            out.append({
                "serviceId": sid,
                "trained": d.trained,
                "healthySamples": len(d.healthy),
                "score": v.score if v else None,
                "effectSigma": round(d.last_effect, 2),
                "mlFired": v.ml_fired if v else False,
                "thresholdFired": v.thr_fired if v else False,
                "features": v.features if v else None,
                "baseline": d.baseline(),
            })
        return out

    def _check_systemic(self, t: int) -> None:
        """Many services degrading at once is one shared cause, not N faults.

        Only root services count: a degraded service whose own synchronous
        dependency is degraded is a symptom (a cache fault slows orders, which
        slows the gateway — one root). Several independent roots at once means
        the host or Docker VM itself is starved; restarting containers would
        not help, so per-service remediation is held.
        """
        degraded = {sid for sid, d in self.detectors.items() if d.degraded()}
        roots = [
            sid for sid in degraded
            if not self._explained(sid, t)
            and not any(
                e["from"] == sid and e["kind"] in ("request", "cache") and e["to"] in degraded
                for e in INFRA_EDGES
            )
        ]
        if len(roots) < config.SYSTEMIC_MIN_ROOTS:
            return
        if t >= self.systemic_until:
            names = ", ".join(sorted(roots))
            log.warning("host-wide degradation across %s", names)
            self._event(
                "anomaly",
                f"Host-wide degradation across {names} — shared cause (host or Docker VM contention); "
                "per-service remediation held",
                "warn",
            )
        self.systemic_until = t + config.SYSTEMIC_HOLD_SEC * 1000

    def _explained(self, sid: str, t: int) -> bool:
        """Degradation with a known cause: a chaos target, an incident in flight,
        or one already escalated to the operator. It is not evidence of a
        host-wide problem."""
        if sid in self.pipelines:
            return True
        if self.run is not None and self.run["target"] == sid:
            return True
        return t - self.escalated_at.get(sid, 0) < config.ESCALATION_MEMORY_SEC * 1000

    def _dependency_cause(self, sid: str, t: int) -> str | None:
        """A synchronous dependency that is down, being remediated or just restarted.

        Its callers' errors and latency are symptoms of that one fault, so they
        must not open (and auto-remediate) incidents of their own.
        """
        for edge in INFRA_EDGES:
            dep = edge["to"]
            if edge["from"] != sid or edge["kind"] not in ("request", "cache") or dep not in SERVICE_IDS:
                continue
            latest = self.latest.get(dep)
            if dep in self.pipelines:
                return dep
            if latest is not None and not (latest.get("running") and latest.get("probeOk")):
                return dep
            if t - self.last_closed.get(dep, 0) < config.DEPENDENCY_SETTLE_SEC * 1000:
                return dep
        # A caller under remediation (restart, scale-out) releases its queued
        # requests in a burst, which briefly slows the services it calls.
        for edge in INFRA_EDGES:
            caller = edge["from"]
            if edge["to"] != sid or edge["kind"] != "request" or caller not in SERVICE_IDS:
                continue
            if caller in self.pipelines:
                return caller
            if t - self.last_closed.get(caller, 0) < config.DEPENDENCY_SETTLE_SEC * 1000:
                return caller
        return None

    def _count_windows(self) -> None:
        if time.monotonic() - self._minute_started < 60:
            return
        self._minute_started = time.monotonic()
        t = now_ms()
        quiet = self.run is None and t - self.last_run_end > 60_000
        if quiet:
            for sid, d in self.detectors.items():
                if d.trained:
                    self.eval_counters["healthyWindows"] += 1
                    if sid in self._minute_fp:
                        self.eval_counters["fpWindows"] += 1
        self._minute_fp = set()
        self.db.put("eval", self.eval_counters)
        # Saved so a backend restart resumes with trained models instead of a
        # fresh 4-minute warm-up.
        for sid, d in self.detectors.items():
            if d.healthy:
                self.db.put(f"baseline:{sid}", d.export_baseline())

    # ========================================================== hub helpers

    def _event(self, kind: str, message: str, severity: str = "info", service_id: str | None = None) -> None:
        e = {"id": self._next("evt"), "t": now_ms(), "kind": kind, "message": message, "severity": severity}
        if service_id:
            e["serviceId"] = service_id
        self.hub.append("events", e)

    def _log(self, level: str, service: str, message: str) -> None:
        self.hub.append("logs", {"id": self._next("log"), "t": now_ms(), "level": level, "service": service,
                                 "message": message})

    def _terminal(self, exe: dict | None, text: str, level: str = "info") -> None:
        line = {"id": self._next("term"), "t": now_ms(), "text": text, "level": level}
        self.hub.append("terminalLines", line)
        if exe is not None:
            exe["lines"].append(line)

    def _set_island(self, state: str) -> None:
        t = now_ms()
        if state == "operational":
            self.island_started = None
        elif self.island == "operational" or self.island_started is None:
            self.island_started = t
        self.island = state
        self.island_changed = t
        self.recovered_since = t if state == "recovered" else None

    def _calm_event(self, services: list[dict]) -> None:
        svc = services[self._calm_index % len(services)]
        slot = self._calm_index % 4
        self._calm_index += 1
        if slot == 0:
            self._event("telemetry", f"Telemetry batch received — {len(services)} services", "info")
        elif slot == 1:
            if svc["status"] == "healthy":
                self._event("health", f"Health check passed — {svc['id']}", "ok", svc["id"])
        elif slot == 2:
            trained = sum(1 for d in self.detectors.values() if d.trained)
            if trained:
                score = max((v.score for v in self.verdicts.values()), default=0.0)
                self._event("anomaly", f"Anomaly scan completed — max score {score:.2f}", "info")
            else:
                self._event("info", "Isolation Forest learning healthy baseline", "info")
        elif svc["containerId"]:
            self._event("info", f"Container heartbeat — {svc['containerId']}", "info", svc["id"])

    def _publish(self) -> None:
        trained = [sid for sid, d in self.detectors.items() if d.trained]
        self.hub.set(
            incidents=self.incidents[-200:],
            executions=self.executions[-50:],
            experimentRuns=self.experiments[-100:],
            diagnosis=self.diagnosis,
            islandState=self.island,
            islandStartedAt=self.island_started,
            islandChangedAt=self.island_changed,
            scenarioPhase=self.scenario_phase,
            activeScenario=self.run["scenarioId"] if self.run else None,
            chaosRun=self.chaos_run,
            settings=self.settings,
            guardrails={"actionsByService": self.guardrails},
            policyTrust={"floor": config.TRUST_FLOOR, "initial": round(self.trust.score(None), 3),
                         "relapseWindowSec": config.RELAPSE_WINDOW_SEC, "records": self.trust.doc()},
            research=evaluation.compute(
                self.experiments, self.detections,
                self.eval_counters["healthyWindows"], self.eval_counters["fpWindows"],
            ),
            model={
                "status": "active" if len(trained) == len(SERVICE_IDS) else "training",
                "trainedServices": len(trained),
                "totalServices": len(SERVICE_IDS),
                "samples": min(len(d.healthy) for d in self.detectors.values()),
                "warmupSamples": config.WARMUP_SAMPLES,
            },
            backend={
                "docker": bool(self.watcher and self.watcher.available),
                "database": self.db.ok,
            },
        )

    # ============================================================ incidents

    def _incident(self, inc_id: str) -> dict | None:
        return next((i for i in self.incidents if i["id"] == inc_id), None)

    def _experiment(self, exp_id: str) -> dict | None:
        return next((e for e in self.experiments if e["id"] == exp_id), None)

    def _save_incident(self, inc: dict) -> None:
        self.db.upsert("incident", inc["id"], inc["detectedAt"], inc)

    def _save_execution(self, exe: dict) -> None:
        self.db.upsert("execution", exe["id"], exe["startedAt"], exe)

    def _stage(self, inc: dict, stage: str, status: str, detail: str | None = None) -> None:
        t = now_ms()
        for s in inc["stages"]:
            if s["stage"] == stage:
                s["status"] = status
                s["at"] = t
                if detail is not None:
                    s["detail"] = detail
                break
        else:
            rec = {"stage": stage, "status": status, "at": t}
            if detail is not None:
                rec["detail"] = detail
            inc["stages"].append(rec)
        self._save_incident(inc)

    def _snapshot_metrics(self, sid: str) -> dict:
        m = self.latest.get(sid) or {}
        out = {k: m[k] for k in ("cpu", "memory", "latencyP95", "errorRate") if k in m}
        if m.get("hitRate") is not None:
            out["hitRate"] = m["hitRate"]
        return out

    def _linked(self, inc_id: str) -> bool:
        return bool(self.run and self.run.get("incidentId") == inc_id)

    def _run_step(self, inc_id: str | None, step: str) -> None:
        if inc_id is None or not self._linked(inc_id) or self.chaos_run is None:
            return
        t = now_ms()
        if self.run and self.run.get("relapses") and step in ("detected", "analyzing", "policy_check"):
            step = "relapsed"
        steps = self.chaos_run["steps"]
        if any(s["id"] == step for s in steps):
            for s in steps:
                if s["id"] == step and s["at"] is None:
                    s["at"] = t
        else:
            steps[:] = [s for s in steps if s["at"] is not None] + [{"id": step, "at": t}]
        self.chaos_run["current"] = step

    def _phase(self, inc_id: str, step: str) -> None:
        self.scenario_phase = STEP_PHASE[step]
        self._run_step(inc_id, step)

    def _run_console(self, inc_id: str, **patch) -> None:
        if self._linked(inc_id) and self.chaos_run is not None:
            self.chaos_run.update(patch)

    async def _pipeline(self, sid: str, trigger: str, verdict: Verdict) -> None:
        inc = None
        exe = None
        try:
            inc, exe = self._open_incident(sid, trigger, verdict)
            self._publish()
            await asyncio.sleep(3)

            # ---- analyze
            self._phase(inc["id"], "analyzing")
            self._set_island("diagnosing")
            inc["status"] = "investigating"
            self._stage(inc, "analyzed", "active", "Matching deviation to fault signatures.")
            self._event("anomaly", "Analyzing telemetry — matching fault signatures", "ai", sid)
            self._publish()
            await asyncio.sleep(3)

            latest = self.latest.get(sid, {})
            base = self.detectors[sid].baseline()
            if base is not None and sid == "redis-cache" and self.hit_baseline is not None:
                base = {**base, "hitRate": self.hit_baseline}
            diag = diagnose(
                SERVICE_BY_ID[sid]["kind"],
                list(self.windows[sid]),
                base,
                latest.get("running", False),
                latest.get("probeOk", False),
                self.settings["decisionThreshold"],
            )
            self.diagnosis = diag
            fault = diag["faultType"]
            policy = POLICY_BY_ID[FAULT_POLICY.get(fault, "UNKNOWN-01")]
            inc.update(
                diagnosis=diag,
                title=FAULT_TITLE.get(fault, "Unclassified anomaly"),
                rootCause=diag.get("summary", ""),
                policyId=policy["id"],
                action=policy["action"],
                severity="critical" if fault == "service_crash" or verdict.thr_fired else inc["severity"],
            )
            self._terminal(exe, f"classification: {fault}", "info")
            self._terminal(exe, f"signature match: {diag['match']:.2f}", "info")
            if fault != "unknown":
                self._check_relapse(inc, exe, sid, fault)
            note = f"{fault} · signature match {round(diag['match'] * 100)}%"
            if inc.get("recurrenceOf"):
                note += f" · relapse of {inc['recurrenceOf']} after {inc['relapseAfterSec']}s"
            self._run_console(inc["id"], diagnosisNote=note)
            self._stage(inc, "analyzed", "complete", f"Signature match {round(diag['match'] * 100)}% — {fault}.")
            self._stage(inc, "policy_check", "active")
            self._phase(inc["id"], "policy_check")
            self._terminal(exe, f"evaluating remediation policy {policy['id']}", "command")
            exe["policyId"] = policy["id"]
            exe["action"] = policy["actionKind"]
            self._publish()
            await asyncio.sleep(1)

            threshold = self.settings["decisionThreshold"]
            if now_ms() < self.systemic_until:
                await self._escalate(
                    inc, exe, sid,
                    policy_note="Host-wide degradation in progress — per-service action withheld",
                    outcome_label="Host-wide degradation — escalated to operator",
                    policy_detail="Several independent services degraded at once; a container action would not help.",
                    toast=f"{sid} degraded alongside other services — check the host.",
                )
                return
            if fault == "unknown" or diag["match"] < threshold:
                await self._escalate(
                    inc, exe, sid,
                    policy_note=f"No signature at or above {threshold:.2f} — escalating ({policy['id']})",
                    outcome_label="No matching signature — escalated to operator",
                    policy_detail=f"No signature cleared the {threshold:.2f} decision threshold.",
                    toast=f"Unclassified anomaly on {sid} needs an operator.",
                )
                return
            if policy["mode"] == "manual" or (policy["risk"] == "restricted" and self.settings["blockRestrictedActions"]):
                await self._escalate(
                    inc, exe, sid,
                    policy_note=f"{policy['id']} is restricted — operator decision required",
                    outcome_label="Restricted policy — escalated to operator",
                    policy_detail="Restricted policies never run automatically.",
                    toast=f"{policy['action']} on {sid} requires an operator.",
                )
                return

            trust = self.trust.trust(policy["id"], sid)
            inc["trustAtDecision"] = round(trust, 3)
            if self.settings["autoRemediation"] and trust < config.TRUST_FLOOR:
                rec = self.trust.record(policy["id"], sid) or {}
                why = (f"{rec.get('relapses', 0)} relapse(s), {rec.get('failures', 0)} failure(s), "
                       f"{rec.get('successes', 0)} durable fix(es)")
                self._terminal(exe, f"policy trust {trust:.2f} < {config.TRUST_FLOOR:.2f} ({why}) → escalating", "error")
                await self._escalate(
                    inc, exe, sid,
                    policy_note=f"Policy trust {trust:.2f} below {config.TRUST_FLOOR:.2f} — {policy['id']} demoted to approval",
                    outcome_label="Policy trust too low — escalated to operator",
                    policy_detail=f"{policy['id']} on {sid} has earned trust {trust:.2f} ({why}); "
                                  f"autonomy requires {config.TRUST_FLOOR:.2f}.",
                    toast=f"{policy['action']} keeps failing to hold on {sid} — operator review needed.",
                )
                return
            self._run_console(inc["id"], policyNote=f"Safe automatic action available: {policy['actionKind']} ({policy['id']})")
            verdict_g = self._guard(sid, policy, inc, exe)
            if verdict_g != "execute":
                notes = {
                    "not_allowed": (
                        f"Automatic remediation is off: {policy['actionKind']} ({policy['id']}) requires approval",
                        "Awaiting operator approval",
                        "Automatic remediation disabled in Settings.",
                        f"{policy['action']} on {sid} needs operator approval.",
                    ),
                    "blocked": (
                        "Guardrail: automatic action limit reached for this service",
                        "Guardrail blocked — escalated to operator",
                        "Guardrail: automatic action limit reached.",
                        f"No further automatic action on {sid} — operator approval required.",
                    ),
                    "cooldown": (
                        "Guardrail: cooldown active for this service",
                        "Cooldown active — escalated to operator",
                        "Guardrail: cooldown between actions not elapsed.",
                        f"{sid} acted on too recently — operator approval required.",
                    ),
                    "dry_run": (
                        f"Dry run: {policy['actionKind']} ({policy['id']}) recommended, not executed",
                        "Recommended — awaiting approval",
                        None,
                        f"Dry run: {policy['action'].lower()} recommended for {sid}.",
                    ),
                }[verdict_g]
                if verdict_g == "dry_run":
                    self._stage(inc, "policy_check", "complete", f"Dry run — {policy['actionKind']} ({policy['id']}) recommended.")
                    self._event("remediation", f"Dry run — {policy['action']} recommended for {sid}, not executed", "warn", sid)
                await self._escalate(inc, exe, sid, policy_note=notes[0], outcome_label=notes[1],
                                     policy_detail=notes[2], toast=notes[3])
                return

            # ---- remediate (real action)
            self._terminal(exe, f"action approved: {policy['actionKind']}", "command")
            self._terminal(exe, "executing...", "info")
            self._phase(inc["id"], "remediating")
            self._set_island("healing")
            self.status_override[sid] = "recovering"
            self._run_console(inc["id"], action=policy["actionKind"])
            self._stage(inc, "policy_check", "complete", f"Safe automatic action available: {policy['actionKind']} ({policy['id']}).")
            self._stage(inc, "remediation", "active", f"{policy['actionKind']} on {sid}")
            inc["status"] = "auto_healing"
            self._event("remediation", f"{policy['action']} — policy {policy['id']}", "ai", sid)
            self._publish()

            try:
                lines = await self._execute(policy["actionKind"], sid)
            except Exception as exc:  # noqa: BLE001
                self._terminal(exe, f"action failed: {exc}", "error")
                self._stage(inc, "remediation", "failed", f"{policy['actionKind']} failed: {exc}")
                self.trust.failed(policy["id"], sid, now_ms(), "action_failed")
                self._save_trust()
                await self._escalate(
                    inc, exe, sid,
                    policy_note=f"{policy['actionKind']} failed — escalating",
                    outcome_label="Remediation failed — escalated to operator",
                    policy_detail=None,
                    toast=f"{policy['action']} on {sid} failed: {exc}",
                )
                return
            for text, level in lines:
                self._terminal(exe, text, level)
            self._stage(inc, "remediation", "complete", f"{policy['actionKind']} completed.")
            self._event("remediation", lines[-1][0] if lines else f"{policy['actionKind']} completed", "ok", sid)
            self._log("INFO", sid, f"SentinelOps executed {policy['actionKind']} ({policy['id']})")
            self._publish()

            # ---- verify
            if self.settings["verifyAfterRemediation"]:
                self._phase(inc["id"], "verifying")
                self._set_island("verifying")
                inc["status"] = "verifying"
                self._stage(inc, "verification", "active")
                self._terminal(exe, "health verification...", "info")
                self._publish()
                ok, checks = await self._verify(sid, fault, inc, exe)
                if not ok:
                    self._stage(inc, "verification", "failed", "Service did not return to healthy bounds.")
                    self.trust.failed(policy["id"], sid, now_ms(), "verify_failed")
                    self._save_trust()
                    await self._escalate(
                        inc, exe, sid,
                        policy_note=f"{policy['actionKind']} ran but verification failed",
                        outcome_label="Verification failed — escalated to operator",
                        policy_detail=None,
                        toast=f"{sid} did not recover after {policy['action'].lower()}.",
                    )
                    return
                self._terminal(exe, "health verification passed", "success")
                self._event("verification", f"{checks} of {checks} health checks passed", "ok", sid)
                self._stage(inc, "verification", "complete", f"{checks} of {checks} health checks passed.")
            else:
                self._stage(inc, "verification", "skipped", "Post-remediation verification disabled in Settings.")

            # ---- resolved
            t = now_ms()
            recovery = round((t - inc["detectedAt"]) / 1000, 1)
            inc.update(status="resolved", auto=True, resolvedAt=t, recoverySec=recovery,
                       after=self._snapshot_metrics(sid))
            self._stage(inc, "resolved", "complete", "Auto-healed.")
            self._phase(inc["id"], "resolved")
            self._set_island("recovered")
            self._run_console(inc["id"], recoverySec=recovery)
            self._terminal(exe, "INCIDENT RESOLVED", "success")
            self._event("verification", f"Auto-recovery complete — {sid} healthy", "ok", sid)
            self.hub.notify("success", "Auto-healed", f"{inc['id']} on {sid} resolved in {recovery}s.")
            exe["outcome"] = "success"
            self.trust.executed(policy["id"], sid, fault, inc["id"], t)
            self._save_trust()
        except asyncio.CancelledError:
            if inc is not None and inc["status"] not in ("resolved", "escalated"):
                inc["status"] = "escalated"
                inc["outcomeLabel"] = "Closed by environment reset"
                self._save_incident(inc)
            if exe is not None and exe["outcome"] == "in_progress":
                exe["outcome"] = "failed"
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("pipeline failed for %s", sid)
            if inc is not None and inc["status"] not in ("resolved", "escalated"):
                inc["status"] = "escalated"
                inc["outcomeLabel"] = f"Pipeline error: {exc}"
                self._save_incident(inc)
            if exe is not None and exe["outcome"] == "in_progress":
                exe["outcome"] = "failed"
        finally:
            self.status_override.pop(sid, None)
            self.container_override.pop(sid, None)
            if exe is not None:
                exe["completedAt"] = now_ms()
                if exe["outcome"] == "in_progress":
                    exe["outcome"] = "failed"
                self._save_execution(exe)
            if inc is not None:
                self._save_incident(inc)
                if self._linked(inc["id"]):
                    self._finish_run(inc)
            self.pipelines.pop(sid, None)
            if sid in self.pipeline_order:
                self.pipeline_order.remove(sid)
            self.last_closed[sid] = now_ms()
            if inc is not None and inc["status"] == "escalated":
                self.escalated_at[sid] = self.last_closed[sid]
            if not self.pipelines:
                self.diagnosis = None
            self._publish()

    def _open_incident(self, sid: str, trigger: str, verdict: Verdict) -> tuple[dict, dict]:
        t = now_ms()
        inc_id = f"INC-{self.counters['incident']}"
        self.counters["incident"] += 1
        exe_id = f"EXE-{self.counters['execution']}"
        self.counters["execution"] += 1
        self.db.put("counters", self.counters)

        stages = [{"stage": s, "status": "pending"} for s in STAGES]
        stages[0] = {"stage": "detected", "status": "complete", "at": t,
                     "detail": "Isolation Forest anomaly score crossed 0.60." if trigger == "ml"
                     else f"Static rule held: {verdict.thr_rule}."}
        inc = {
            "id": inc_id,
            "title": f"Anomaly on {sid}",
            "serviceId": sid,
            "severity": "critical" if trigger == "threshold" else "warning",
            "status": "detected",
            "rootCause": "Under analysis.",
            "action": "Pending diagnosis",
            "detectedAt": t,
            "stages": stages,
            "anomalyScore": verdict.score,
            "before": self._snapshot_metrics(sid),
            "auto": False,
        }
        exe = {
            "id": exe_id,
            "incidentId": inc_id,
            "policyId": "",
            "serviceId": sid,
            "action": "",
            "startedAt": t,
            "outcome": "in_progress",
            "dryRun": self.settings["dryRun"],
            "lines": [],
        }
        run = self.run
        if (run is not None and run.get("injectedAt") and run["target"] == sid
                and not run.get("incidentId") and not run.get("reinjectAt")):
            run["incidentId"] = inc_id
            inc["scenarioId"] = run["scenarioId"]
            if self.chaos_run is not None:
                self.chaos_run["incidentId"] = inc_id
        self.incidents.append(inc)
        self.incidents = self.incidents[-200:]
        self.executions.append(exe)
        self.executions = self.executions[-50:]
        self.hub.set(selectedExecutionId=exe_id)
        self._save_incident(inc)
        self._save_execution(exe)

        self._phase(inc_id, "detected")
        self._set_island("anomaly")
        detector = "Isolation Forest" if trigger == "ml" else "static threshold rule"
        self._terminal(exe, f"anomaly detected on {sid} ({detector})", "warn")
        self._event("incident", f"{inc_id} opened — {sid}", "crit", sid)
        self._log("WARN", sid, f"SentinelOps opened {inc_id}: anomaly detected by {detector}")
        self.hub.notify("warning", "Anomaly detected", f"{inc_id} opened on {sid}.")
        return inc, exe

    async def _escalate(self, inc, exe, sid, policy_note, outcome_label, policy_detail, toast) -> None:
        self._run_console(inc["id"], policyNote=policy_note, action=None)
        self._terminal(exe, "ESCALATED — awaiting operator approval", "error")
        self._phase(inc["id"], "escalated")
        self._set_island("escalated")
        if policy_detail is not None:
            self._stage(inc, "policy_check", "failed", policy_detail)
        self._stage(inc, "escalated", "failed", "Awaiting operator approval.")
        inc.update(status="escalated", auto=False, outcomeLabel=outcome_label)
        exe["outcome"] = "escalated"
        self._event("incident", f"Escalated to operator — {outcome_label}", "crit", sid)
        self._log("ERROR", sid, f"Escalated: {outcome_label}")
        self.hub.notify("warning", "Escalated to operator", toast)
        self.db.audit(now_ms(), {"type": "escalation", "incidentId": inc["id"], "serviceId": sid, "reason": outcome_label})

    def _save_trust(self) -> None:
        self.db.put("trust", self.trust.export())

    def _check_relapse(self, inc: dict, exe: dict, sid: str, fault: str) -> None:
        """The same fault returning after a fix means the fix was not durable."""
        t = now_ms()
        hit = self.trust.relapse(sid, fault, t)
        if hit is None:
            return
        self._save_trust()
        after = round((t - hit["at"]) / 1000)
        prev = self._incident(hit["incidentId"]) if hit.get("incidentId") else None
        inc["recurrenceOf"] = hit.get("incidentId")
        inc["relapseAfterSec"] = after
        if prev is not None:
            prev["relapsedAt"] = t
            prev["relapsedBy"] = inc["id"]
            self._save_incident(prev)
        label = hit.get("incidentId") or "previous fix"
        self._terminal(exe, f"relapse: {fault} returned {after}s after {label} was fixed by {hit['policyId']}", "warn")
        self._event("incident", f"Relapse — {fault} back on {sid} {after}s after {label}; fix counted as not durable",
                    "crit", sid)
        if self.run is not None and self.run.get("incidentId") == inc["id"] and self.chaos_run is not None:
            self._run_step(inc["id"], "relapsed")

    def _guard(self, sid: str, policy: dict, inc: dict, exe: dict) -> str:
        t = now_ms()
        window = self.settings["guardrailWindowSec"] * 1000
        recent = [x for x in self.guardrails.get(sid, []) if t - x < window]
        self.guardrails[sid] = recent
        if not self.settings["autoRemediation"]:
            self._terminal(exe, f"automatic remediation disabled — {policy['actionKind']} requires operator approval", "error")
            return "not_allowed"
        if len(recent) >= self.settings["restartLimit"]:
            minutes = round(self.settings["guardrailWindowSec"] / 60)
            self._terminal(exe, f"guardrail: restart limit reached ({self.settings['restartLimit']}/{minutes}min) → escalating to operator", "error")
            self.db.put("guardrails", self.guardrails)
            return "blocked"
        cooldown = self.settings["cooldownSec"] * 1000
        if recent and t - recent[-1] < cooldown:
            remaining = round((cooldown - (t - recent[-1])) / 1000)
            self._terminal(exe, f"guardrail: cooldown active ({remaining}s remaining) → escalating to operator", "error")
            return "cooldown"
        if self.settings["dryRun"]:
            self._terminal(exe, f"DRY RUN: would execute {policy['actionKind']}", "warn")
            return "dry_run"
        self.guardrails[sid] = recent + [t]
        self.db.put("guardrails", self.guardrails)
        self.db.audit(t, {"type": "action", "incidentId": inc["id"], "serviceId": sid, "policyId": policy["id"],
                          "action": policy["actionKind"]})
        return "execute"

    async def _execute(self, kind: str, sid: str) -> list[tuple[str, str]]:
        """Run a real remediation action. Returns terminal lines."""
        if self.watcher is None and kind != "clear_cache":
            raise RuntimeError("Docker is not reachable")
        if kind in ("restart_container", "restart_worker"):
            self.container_override[sid] = "restarting"
            self._publish()
            info = self.watcher.primary(sid)  # type: ignore[union-attr]
            name = info["name"] if info else sid
            started = time.perf_counter()
            await asyncio.to_thread(self.watcher.restart, sid)  # type: ignore[union-attr]
            await asyncio.to_thread(self.watcher.refresh)  # type: ignore[union-attr]
            self.container_override.pop(sid, None)
            took = time.perf_counter() - started
            return [(f"$ docker restart {name}", "command"), (f"{name} restarted in {took:.1f}s", "success")]
        if kind == "clear_cache":
            before = await self.redis_cache.info("memory")
            await self.redis_cache.flushdb()
            after = await self.redis_cache.info("memory")
            freed = (int(before.get("used_memory", 0)) - int(after.get("used_memory", 0))) / 1024 / 1024
            return [("$ redis-cli -n 0 FLUSHDB", "command"), (f"cache db0 flushed — {freed:.1f} MB freed", "success")]
        if kind == "scale_replicas":
            name = await asyncio.to_thread(self.watcher.scale_out, sid, config.MAX_REPLICAS)  # type: ignore[union-attr]
            await asyncio.to_thread(self.watcher.refresh)  # type: ignore[union-attr]
            return [
                (f"$ docker run -d --name {name} --network-alias {sid} {SERVICE_BY_ID[sid]['id']}", "command"),
                (f"replica {name} started — traffic now shared across replicas", "success"),
            ]
        raise RuntimeError(f"{kind} is not an executable action")

    def _verify_check(self, sid: str, fault: str) -> tuple[bool, str]:
        m = self.latest.get(sid) or {}
        if not m.get("running") or not m.get("probeOk"):
            return False, "waiting for service"
        if m["errorRate"] >= 2:
            return False, f"error rate {m['errorRate']}%"
        base = self.detectors[sid].baseline() or {}
        if fault == "memory_leak":
            limit = (base.get("memory") or 50) + 10
            return m["memory"] < limit, f"memory {m['memory']}% (limit {limit:.0f}%)"
        if fault == "cpu_saturation":
            return m["cpu"] < 80, f"cpu {m['cpu']}% across replicas"
        if fault == "latency_spike":
            return m["latencyP95"] < 300, f"p95 {m['latencyP95']} ms"
        if fault == "cache_saturation":
            return m["memory"] < 80, f"cache memory {m['memory']}%"
        return True, f"error rate {m['errorRate']}%"

    async def _verify(self, sid: str, fault: str, inc: dict, exe: dict) -> tuple[bool, int]:
        deadline = time.monotonic() + config.VERIFY_TIMEOUT_SEC
        passes = 0
        announced = 0
        while time.monotonic() < deadline:
            await asyncio.sleep(config.TICK_SEC)
            ok, detail = self._verify_check(sid, fault)
            if ok:
                passes += 1
                if passes in (1, 3, config.VERIFY_PASSES) and announced < 3:
                    announced += 1
                    text = "process up, probe answering" if passes == 1 else detail
                    if self._linked(inc["id"]) and self.chaos_run is not None:
                        self.chaos_run["healthChecks"] = self.chaos_run["healthChecks"] + [text]
                    self._terminal(exe, f"check {announced}/3 passed — {text}", "success")
                    self._publish()
                if passes >= config.VERIFY_PASSES:
                    return True, 3
            else:
                passes = 0
        return False, announced

    # ================================================================ chaos

    async def inject(self, scenario_id: str) -> dict:
        async with self._lock:
            scn = SCENARIOS.get(scenario_id)
            if scn is None:
                return {"accepted": False, "reason": "Unknown scenario"}
            if self.run is not None:
                return {"accepted": False, "reason": "A chaos run is already in progress"}
            target = scn["target"]
            det = self.detectors[target]
            if not det.trained:
                reason = (f"Isolation Forest is still learning {target}'s baseline "
                          f"({len(det.healthy)}/{config.WARMUP_SAMPLES} samples)")
                self.hub.notify("warning", "Chaos run not started", reason)
                return {"accepted": False, "reason": reason}
            if target in self.pipelines:
                reason = f"{target} already has an open incident"
                self.hub.notify("warning", "Chaos run not started", reason)
                return {"accepted": False, "reason": reason}
            latest = self.latest.get(target) or {}
            if not latest.get("running") or not latest.get("probeOk"):
                reason = f"{target} is not running — reset the environment first"
                self.hub.notify("warning", "Chaos run not started", reason)
                return {"accepted": False, "reason": reason}

            t = now_ms()
            exp_id = f"EXP-{self.counters['experiment']}"
            self.counters["experiment"] += 1
            self.db.put("counters", self.counters)
            exp = {
                "id": exp_id, "scenarioId": scenario_id, "faultType": scn["faultType"], "target": target,
                "injectedAt": t + config.COUNTDOWN_SEC * 1000, "thresholdDetectedAt": None, "mlDetectedAt": None,
                "remediatedAt": None, "outcome": "running",
            }
            self.experiments.append(exp)
            self.experiments = self.experiments[-100:]
            if scn.get("recurs"):
                steps = AUTO_HEAL_STEPS + ["relapsed", "escalated"]
            else:
                steps = ESCALATE_STEPS if scn["expected"] == "escalate" else AUTO_HEAL_STEPS
            # A deliberately injected fault is a new fault, not a relapse of
            # whatever was fixed before.
            self.trust.pending = [p for p in self.trust.pending if p["serviceId"] != target]
            self.chaos_run = {
                "runId": exp_id, "scenarioId": scenario_id, "title": scn["title"], "target": target,
                "metric": scn["metric"], "threshold": scn["threshold"], "thresholdLabel": scn["thresholdLabel"],
                "requestedAt": t, "injectedAt": None, "countdown": config.COUNTDOWN_SEC,
                "steps": [{"id": s, "at": None} for s in steps], "current": None, "incidentId": None,
                "diagnosisNote": None, "policyNote": None, "healthChecks": [], "action": None,
                "outcome": "running", "finishedAt": None, "mlDetectedSec": None, "thresholdDetectedSec": None,
                "recoverySec": None,
            }
            self.run = {"id": exp_id, "scenarioId": scenario_id, "target": target, "injectedAt": None,
                        "incidentId": None, "armedAt": None, "relapses": 0, "reinjectAt": None}
            self.scenario_phase = "injecting"
            self.db.upsert("experiment", exp_id, exp["injectedAt"], exp)
            self._publish()
            self.run_task = asyncio.create_task(self._run_chaos(exp_id))
            return {"accepted": True, "runId": exp_id}

    async def _run_chaos(self, run_id: str) -> None:
        try:
            for remaining in range(config.COUNTDOWN_SEC, 0, -1):
                if self.chaos_run and self.chaos_run["runId"] == run_id:
                    self.chaos_run["countdown"] = remaining
                    self._publish()
                await asyncio.sleep(1)
            run = self.run
            if run is None or run["id"] != run_id:
                return
            scn = SCENARIOS[run["scenarioId"]]
            try:
                await self._apply_fault(run["scenarioId"], run["target"])
            except Exception as exc:  # noqa: BLE001
                log.exception("fault injection failed")
                self._event("incident", f"Fault injection failed — {exc}", "crit", run["target"])
                self.hub.notify("error", "Fault injection failed", str(exc))
                self._close_run("cancelled")
                return
            t = now_ms()
            run["injectedAt"] = t
            run["armedAt"] = t
            exp = self._experiment(run_id)
            if exp:
                exp["injectedAt"] = t
                self.db.upsert("experiment", run_id, t, exp)
            if self.chaos_run:
                self.chaos_run.update(injectedAt=t, countdown=None, current="injected")
                for s in self.chaos_run["steps"]:
                    if s["id"] == "injected":
                        s["at"] = t
            self._event("incident", f"Fault injected — {scn['title']} on {run['target']}", "warn", run["target"])
            self._log("WARN", run["target"], f"Chaos Lab injected fault: {scn['faultType']}")
            self._publish()

            # Wait for real detection; the pipeline finishes the run.
            hard_deadline = time.monotonic() + 300 * (1 + scn.get("recurs", 0))
            while True:
                await asyncio.sleep(0.5)
                current = self.run
                if current is None or current["id"] != run_id:
                    return
                if current.get("reinjectAt") and now_ms() >= current["reinjectAt"]:
                    current["reinjectAt"] = None
                    try:
                        await self._apply_fault(current["scenarioId"], current["target"])
                    except Exception as exc:  # noqa: BLE001
                        log.warning("re-injection failed: %s", exc)
                        self._close_run("failed")
                        return
                    current["armedAt"] = now_ms()
                    self._event("incident", f"Underlying bug re-emerged — {scn['faultType']} on {current['target']} "
                                f"(recurrence {current['relapses']})", "warn", current["target"])
                    self._log("WARN", current["target"], "Chaos Lab: leak re-emerged after restart (bug not fixed)")
                    self._publish()
                armed = current.get("armedAt") or t
                if (not current.get("incidentId") and not current.get("reinjectAt")
                        and now_ms() - armed > config.DETECTION_TIMEOUT_SEC * 1000):
                    self._event("anomaly", f"No detection within {config.DETECTION_TIMEOUT_SEC}s — run recorded as missed", "crit", run["target"])
                    self.hub.notify("warning", "Fault not detected", f"{scn['title']} on {run['target']} was missed.")
                    await self._revert_faults()
                    self._close_run("failed")
                    return
                if time.monotonic() > hard_deadline:
                    self._close_run("failed")
                    return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("chaos run failed")
            self._close_run("cancelled")

    async def _apply_fault(self, scenario_id: str, target: str) -> None:
        if scenario_id == "cpu-spike":
            await self.redis_ctl.set("chaos:cpu-burn-ms", 60, ex=240)
            return
        if scenario_id == "cache-saturation":
            await self._saturate_cache()
            return
        if self.watcher is None:
            raise RuntimeError("Docker is not reachable")
        info = self.watcher.primary(target)
        if info is None or not info["running"] or not info["ip"]:
            raise RuntimeError(f"{target} is not running")
        path = {
            "memory-leak": "/chaos/memory-leak?mb_per_sec=3",
            "recurring-leak": "/chaos/memory-leak?mb_per_sec=3",
            "unknown-anomaly": "/chaos/mixed?seconds=150",
            "service-crash": "/chaos/crash",
            "latency-injection": "/chaos/latency?ms=650",
        }[scenario_id]
        await self.prober.post_chaos(info, path)

    async def _saturate_cache(self) -> None:
        """A noisy neighbour writes large keys without TTL until Redis refuses."""
        payload = b"\x5a" * (512 * 1024)
        for i in range(400):
            try:
                await self.redis_cache.set(f"noise:{i}", payload)
            except OutOfMemoryError:
                return
            except ResponseError as exc:
                if "OOM" in str(exc) or "maxmemory" in str(exc):
                    return
                raise
        log.warning("cache saturation wrote 400 keys without hitting maxmemory")

    async def _revert_faults(self) -> list[str]:
        done: list[str] = []
        if self.watcher is not None:
            containers, _ = self.watcher.snapshot()
            for c in containers.values():
                if c["running"] and c["service"] in HTTP_SERVICES and c["ip"]:
                    try:
                        await self.prober.post_chaos(c, "/chaos/reset")
                    except Exception:  # noqa: BLE001
                        pass
        try:
            await self.redis_ctl.delete("chaos:cpu-burn-ms")
            keys = [k async for k in self.redis_cache.scan_iter(match="noise:*", count=500)]
            if keys:
                await self.redis_cache.delete(*keys)
            done.append("chaos flags cleared")
        except Exception as exc:  # noqa: BLE001
            log.warning("redis revert failed: %s", exc)
        if self.watcher is not None:
            removed = await asyncio.to_thread(self.watcher.remove_replicas)
            started = await asyncio.to_thread(self.watcher.start_stopped)
            done += [f"removed {n}" for n in removed] + [f"started {n}" for n in started]
        return done

    def _finish_run(self, inc: dict) -> None:
        outcome = "auto_healed" if inc["status"] == "resolved" else "escalated"
        run = self.run
        scn = SCENARIOS.get(run["scenarioId"], {}) if run else {}
        if run is not None and outcome == "auto_healed" and run["relapses"] < scn.get("recurs", 0):
            # The restart cleared the symptom, not the bug: it comes back.
            run["relapses"] += 1
            run["incidentId"] = None
            run["reinjectAt"] = now_ms() + config.RELAPSE_REINJECT_SEC * 1000
            if self.chaos_run is not None:
                self.chaos_run["healthChecks"] = []
                self.chaos_run["policyNote"] = (f"Fix applied — the underlying bug is still there; "
                                                f"expect it back in ~{config.RELAPSE_REINJECT_SEC}s")
            return
        exp = self._experiment(run["id"]) if run else None
        if exp and outcome == "auto_healed":
            exp["remediatedAt"] = inc.get("resolvedAt")
        self._close_run(outcome)

    def _close_run(self, outcome: str) -> None:
        run = self.run
        if run is None:
            return
        t = now_ms()
        exp = self._experiment(run["id"])
        if exp:
            exp["outcome"] = outcome
            self.db.upsert("experiment", exp["id"], exp["injectedAt"], exp)
        if self.chaos_run and self.chaos_run["runId"] == run["id"]:
            self.chaos_run.update(outcome=outcome, finishedAt=t, current=None)
        self.run = None
        self.last_run_end = t
        self._publish()

    # ============================================================== commands

    async def reset(self) -> dict:
        async with self._lock:
            if self.run_task and not self.run_task.done():
                self.run_task.cancel()
            self._close_run("cancelled")
            tasks = list(self.pipelines.values())
            for task in tasks:
                task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        actions = await self._revert_faults()
        async with self._lock:
            self.guardrails = {}
            self.db.put("guardrails", self.guardrails)
            for d in self.detectors.values():
                d.reset_state()
            for sid in SERVICE_IDS:
                self.fired_at[sid] = {"ml": None, "threshold": None}
            self.status_override.clear()
            self.container_override.clear()
            self.deferred.clear()
            self.escalated_at.clear()
            # Earned trust survives a reset; open durability checks do not,
            # because the faults they were watching for have been reverted.
            self.trust.pending.clear()
            self._save_trust()
            self.systemic_until = 0
            self.diagnosis = None
            self.chaos_run = None
            self.scenario_phase = "idle"
            self._set_island("operational")
            self.last_run_end = now_ms()
            self._event("info", "Environment reset — faults reverted, guardrail counters cleared", "info")
            self.db.audit(now_ms(), {"type": "reset", "actions": actions})
            self._publish()
        await self.hub.broadcast_snapshot()
        return {"ok": True, "actions": actions}

    async def reset_trust(self, policy_id: str | None, service_id: str | None) -> dict:
        async with self._lock:
            self.trust.reset(policy_id, service_id)
            self._save_trust()
            scope = f"{policy_id} on {service_id}" if policy_id else "all policies"
            self._event("remediation", f"Policy trust reset by operator — {scope}", "info", service_id)
            self.db.audit(now_ms(), {"type": "trust_reset", "policyId": policy_id, "serviceId": service_id})
            self._publish()
            return {"ok": True, "policyTrust": self.trust.doc()}

    async def update_settings(self, patch: dict) -> dict:
        async with self._lock:
            for k, v in patch.items():
                if k not in SETTINGS_TYPES:
                    continue
                expected = SETTINGS_TYPES[k]
                if expected is float and isinstance(v, int) and not isinstance(v, bool):
                    v = float(v)
                if expected is int and isinstance(v, float) and v.is_integer():
                    v = int(v)
                if not isinstance(v, expected) or (expected is int and isinstance(v, bool)):
                    continue
                if k == "decisionThreshold":
                    v = max(0.5, min(0.99, v))
                if k in ("restartLimit",):
                    v = max(0, min(10, v))
                if k in ("guardrailWindowSec", "cooldownSec"):
                    v = max(0, min(86_400, v))
                self.settings[k] = v
            self.db.put("settings", self.settings)
            self._publish()
            return self.settings

    async def manual_execute(self, policy_id: str, service_id: str, incident_id: str | None, dry_run: bool | None) -> dict:
        policy = POLICY_BY_ID.get(policy_id)
        if policy is None or service_id not in SERVICE_BY_ID:
            raise ValueError("unknown policy or service")
        t = now_ms()
        async with self._lock:
            exe = {
                "id": f"EXE-{self.counters['execution']}", "incidentId": incident_id or "", "policyId": policy_id,
                "serviceId": service_id, "action": policy["actionKind"], "startedAt": t, "outcome": "in_progress",
                "dryRun": bool(dry_run), "lines": [],
            }
            self.counters["execution"] += 1
            self.db.put("counters", self.counters)
            self.executions.append(exe)
            self.executions = self.executions[-50:]
            self.hub.set(selectedExecutionId=exe["id"])
            self._terminal(exe, f"operator approved {policy['actionKind']} on {service_id} ({policy_id})", "command")
            self._publish()
        try:
            if dry_run:
                self._terminal(exe, f"DRY RUN: would execute {policy['actionKind']}", "warn")
                exe["outcome"] = "success"
            elif policy["actionKind"] in ("alert_operator", "escalate"):
                self._terminal(exe, "no automated action for this policy — recorded for the operator", "info")
                exe["outcome"] = "escalated"
            else:
                for text, level in await self._execute(policy["actionKind"], service_id):
                    self._terminal(exe, text, level)
                exe["outcome"] = "success"
                inc = self._incident(incident_id) if incident_id else None
                fault = ((inc or {}).get("diagnosis") or {}).get("faultType") or next(
                    (f for f, p in FAULT_POLICY.items() if p == policy_id), None)
                if fault and fault != "unknown":
                    # An operator-approved fix that holds earns the policy trust back.
                    self.trust.executed(policy_id, service_id, fault, incident_id, now_ms())
                    self._save_trust()
                if inc and inc["status"] == "escalated":
                    inc.update(status="resolved", resolvedAt=now_ms(),
                               recoverySec=round((now_ms() - inc["detectedAt"]) / 1000, 1),
                               outcomeLabel="Resolved by operator action", after=self._snapshot_metrics(service_id))
                    self._stage(inc, "resolved", "complete", "Resolved by operator action.")
        except Exception as exc:  # noqa: BLE001
            self._terminal(exe, f"action failed: {exc}", "error")
            exe["outcome"] = "failed"
        exe["completedAt"] = now_ms()
        self._save_execution(exe)
        self.db.audit(now_ms(), {"type": "manual_action", "executionId": exe["id"], "policyId": policy_id,
                                 "serviceId": service_id, "outcome": exe["outcome"]})
        self._publish()
        return exe
