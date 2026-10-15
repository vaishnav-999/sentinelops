"""Docker Engine access: discovery, live stats, log streaming and actions.

Containers are discovered by label (sentinelops.role=target,
sentinelops.service=<id>), so any container carrying those labels is monitored.
Stats and logs are read on background threads (the Docker SDK is blocking) and
exposed as thread-safe snapshots for the async control loop.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from datetime import datetime

import docker
from docker.errors import APIError, NotFound

log = logging.getLogger("sentinel.docker")

LABEL_ROLE = "sentinelops.role"
LABEL_SERVICE = "sentinelops.service"
LABEL_REPLICA = "sentinelops.replica"

LEVEL_RE = re.compile(r"^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+(.*)$")


def parse_docker_time(value: str | None) -> int | None:
    """'2026-10-15T14:00:00.123456789Z' -> epoch ms."""
    if not value or value.startswith("0001-"):
        return None
    try:
        main, _, frac = value.rstrip("Z").partition(".")
        frac = (frac + "000000")[:6]
        dt = datetime.fromisoformat(f"{main}.{frac}+00:00")
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def normalise_level(raw: str) -> str:
    raw = raw.upper()
    if raw in ("WARNING", "WARN"):
        return "WARN"
    if raw in ("ERROR", "CRITICAL", "FATAL"):
        return "ERROR"
    if raw == "DEBUG":
        return "DEBUG"
    return "INFO"


def parse_log_line(line: str) -> tuple[str, str]:
    m = LEVEL_RE.match(line)
    if m:
        return normalise_level(m.group(1)), m.group(2)
    lowered = line.lower()
    if "fatal" in lowered or "error" in lowered or "panic" in lowered:
        return "ERROR", line
    if "warn" in lowered:
        return "WARN", line
    return "INFO", line


class DockerWatcher:
    def __init__(self) -> None:
        self.client = docker.from_env(timeout=20)
        self.api = self.client.api
        self.lock = threading.Lock()
        self.containers: dict[str, dict] = {}
        self.stats: dict[str, dict] = {}
        self.logs: deque[dict] = deque(maxlen=5000)
        self._stat_threads: dict[str, threading.Thread] = {}
        self._log_threads: dict[str, threading.Thread] = {}
        self.network: str | None = None
        self.available = True
        self.last_error: str | None = None

    # -------------------------------------------------------------- discovery

    def refresh(self) -> None:
        try:
            found = self.client.containers.list(all=True, filters={"label": f"{LABEL_ROLE}=target"})
            self.available = True
            self.last_error = None
        except Exception as exc:  # noqa: BLE001
            self.available = False
            self.last_error = str(exc)
            log.warning("docker list failed: %s", exc)
            return

        current: dict[str, dict] = {}
        for c in found:
            a = c.attrs
            labels = a.get("Config", {}).get("Labels", {}) or {}
            state = a.get("State", {}) or {}
            networks = (a.get("NetworkSettings", {}) or {}).get("Networks", {}) or {}
            ip = None
            for name, net in networks.items():
                if net.get("IPAddress"):
                    ip = net["IPAddress"]
                    if self.network is None and not labels.get(LABEL_REPLICA):
                        self.network = name
                    break
            status = state.get("Status", "unknown")
            health = (state.get("Health") or {}).get("Status")
            nano = (a.get("HostConfig", {}) or {}).get("NanoCpus") or 0
            current[c.id] = {
                "id": c.id,
                "short": c.id[:12],
                "name": c.name,
                "service": labels.get(LABEL_SERVICE, ""),
                "replica": bool(labels.get(LABEL_REPLICA)),
                "image": (a.get("Config", {}) or {}).get("Image", ""),
                "status": status,
                "health": health,
                "running": status == "running",
                "startedAt": parse_docker_time(state.get("StartedAt")),
                "createdAt": parse_docker_time(a.get("Created")),
                "restartCount": a.get("RestartCount", 0),
                "ip": ip,
                "cpuLimit": nano / 1e9 if nano else None,
            }

        with self.lock:
            self.containers = current
            for cid in list(self.stats):
                if cid not in current or not current[cid]["running"]:
                    self.stats.pop(cid, None)

        for cid, info in current.items():
            if not info["running"]:
                continue
            if cid not in self._stat_threads or not self._stat_threads[cid].is_alive():
                t = threading.Thread(target=self._stats_loop, args=(cid,), daemon=True)
                self._stat_threads[cid] = t
                t.start()
            if cid not in self._log_threads or not self._log_threads[cid].is_alive():
                t = threading.Thread(target=self._logs_loop, args=(cid, info["service"]), daemon=True)
                self._log_threads[cid] = t
                t.start()

    def snapshot(self) -> tuple[dict[str, dict], dict[str, dict]]:
        with self.lock:
            return dict(self.containers), dict(self.stats)

    def drain_logs(self, limit: int = 300) -> list[dict]:
        out = []
        with self.lock:
            while self.logs and len(out) < limit:
                out.append(self.logs.popleft())
        return out

    # ------------------------------------------------------------ stats/logs

    def _stats_loop(self, cid: str) -> None:
        try:
            for s in self.api.stats(cid, stream=True, decode=True):
                parsed = self._parse_stats(cid, s)
                if parsed is None:
                    continue
                with self.lock:
                    info = self.containers.get(cid)
                    if info is None or not info["running"]:
                        break
                    self.stats[cid] = parsed
        except Exception as exc:  # noqa: BLE001
            log.debug("stats stream ended for %s: %s", cid[:12], exc)

    def _parse_stats(self, cid: str, s: dict) -> dict | None:
        cpu = s.get("cpu_stats") or {}
        pre = s.get("precpu_stats") or {}
        total = (cpu.get("cpu_usage") or {}).get("total_usage")
        pre_total = (pre.get("cpu_usage") or {}).get("total_usage")
        system = cpu.get("system_cpu_usage")
        pre_system = pre.get("system_cpu_usage")
        if total is None or system is None or pre_total is None or pre_system is None:
            return None
        online = cpu.get("online_cpus") or len((cpu.get("cpu_usage") or {}).get("percpu_usage") or []) or 1
        cpu_delta = total - pre_total
        sys_delta = system - pre_system
        cores_used = (cpu_delta / sys_delta) * online if sys_delta > 0 else 0.0
        with self.lock:
            limit_cores = (self.containers.get(cid) or {}).get("cpuLimit") or online
        cpu_pct = max(0.0, min(100.0, cores_used / limit_cores * 100))

        mem = s.get("memory_stats") or {}
        usage = mem.get("usage") or 0
        mstats = mem.get("stats") or {}
        cache = mstats.get("inactive_file", mstats.get("total_inactive_file", 0)) or 0
        used = max(0, usage - cache)
        limit = mem.get("limit") or 0
        mem_pct = (used / limit * 100) if limit else 0.0
        return {
            "cpu": round(cpu_pct, 1),
            "memory": round(min(100.0, mem_pct), 1),
            "memBytes": used,
            "memLimit": limit,
            "t": time.time(),
        }

    def _logs_loop(self, cid: str, service: str) -> None:
        buf = b""
        try:
            stream = self.api.logs(cid, stream=True, follow=True, since=int(time.time()))
            for chunk in stream:
                buf += chunk
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    level, message = parse_log_line(line)
                    with self.lock:
                        self.logs.append(
                            {"t": int(time.time() * 1000), "level": level, "service": service, "message": message[:500]}
                        )
        except Exception as exc:  # noqa: BLE001
            log.debug("log stream ended for %s: %s", cid[:12], exc)

    # ---------------------------------------------------------------- actions

    def primary(self, service: str) -> dict | None:
        with self.lock:
            for info in self.containers.values():
                if info["service"] == service and not info["replica"]:
                    return info
        return None

    def replicas(self, service: str | None = None) -> list[dict]:
        with self.lock:
            return [
                i for i in self.containers.values()
                if i["replica"] and (service is None or i["service"] == service)
            ]

    def restart(self, service: str, timeout: int = 5) -> str:
        info = self.primary(service)
        if info is None:
            raise RuntimeError(f"no container found for {service}")
        container = self.client.containers.get(info["id"])
        container.restart(timeout=timeout)
        return info["name"]

    def start(self, container_id: str) -> None:
        self.client.containers.get(container_id).start()

    def scale_out(self, service: str, max_replicas: int) -> str:
        info = self.primary(service)
        if info is None:
            raise RuntimeError(f"no container found for {service}")
        existing = self.replicas(service)
        if len(existing) + 1 >= max_replicas:
            raise RuntimeError(f"{service} already at max replicas ({max_replicas})")
        src = self.client.containers.get(info["id"])
        a = src.attrs
        cfg = a["Config"]
        host = a["HostConfig"]
        network = next(iter((a["NetworkSettings"]["Networks"] or {}).keys()), None)
        if network is None:
            raise RuntimeError("source container has no network")
        index = len(existing) + 2
        name = f"{info['name']}-r{index}"
        labels = dict(cfg.get("Labels") or {})
        labels = {k: v for k, v in labels.items() if not k.startswith("com.docker.compose")}
        labels[LABEL_REPLICA] = "true"
        try:
            stale = self.client.containers.get(name)
            stale.remove(force=True)
        except NotFound:
            pass
        replica = self.client.containers.create(
            image=a["Image"],
            name=name,
            environment=cfg.get("Env"),
            command=cfg.get("Cmd"),
            labels=labels,
            mem_limit=host.get("Memory") or None,
            nano_cpus=host.get("NanoCpus") or None,
            network=network,
        )
        net = self.client.networks.get(network)
        net.disconnect(replica)
        net.connect(replica, aliases=[service])
        replica.start()
        return name

    def remove_replicas(self) -> list[str]:
        removed = []
        for info in self.replicas():
            try:
                self.client.containers.get(info["id"]).remove(force=True)
                removed.append(info["name"])
            except (NotFound, APIError) as exc:
                log.warning("could not remove replica %s: %s", info["name"], exc)
        return removed

    def start_stopped(self) -> list[str]:
        started = []
        with self.lock:
            stopped = [i for i in self.containers.values() if not i["running"] and not i["replica"]]
        for info in stopped:
            try:
                self.start(info["id"])
                started.append(info["name"])
            except (NotFound, APIError) as exc:
                log.warning("could not start %s: %s", info["name"], exc)
        return started
