"""Stage 2 — diagnosis.

Matches the recent telemetry window of one service against known fault
signatures and returns a "signature match" (0–1), never a confidence. Anything
below the decision threshold is reported as UNKNOWN with the closest candidate.
"""

from __future__ import annotations

import numpy as np

SIGNATURES = {
    "service_crash": ("CRASH", "Process exited or stopped answering health checks."),
    "memory_leak": ("MEM-LEAK", "Sustained, near-linear memory growth."),
    "cpu_saturation": ("CPU-SAT", "CPU pinned at its limit under steady load."),
    "latency_spike": ("LATENCY", "Response times far above baseline with a normal error rate."),
    "cache_saturation": ("CACHE-SAT", "Cache memory at its limit with a collapsing hit rate."),
}


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def linear_fit(values: list[float]) -> tuple[float, float]:
    """Slope per sample and R² of a least-squares line."""
    if len(values) < 5:
        return 0.0, 0.0
    y = np.array(values, dtype=float)
    x = np.arange(len(y), dtype=float)
    slope, intercept = np.polyfit(x, y, 1)
    pred = slope * x + intercept
    ss_res = float(((y - pred) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot > 1e-9 else 0.0
    return float(slope), float(r2)


def diagnose(
    kind: str,
    window: list[dict],
    baseline: dict | None,
    running: bool,
    probe_ok: bool,
    decision_threshold: float,
) -> dict:
    """window: recent metric dicts (oldest first), ~1 s apart."""
    last = window[-5:] if window else []

    def avg(key: str, rows=last) -> float:
        vals = [r.get(key) for r in rows if r.get(key) is not None]
        return float(sum(vals) / len(vals)) if vals else 0.0

    base = baseline or {}
    candidates: list[tuple[str, float, str]] = []

    # Crash: the process is gone or not answering.
    if not running:
        candidates.append(("service_crash", 0.97, "Container exited; no process to serve traffic."))
    elif not probe_ok:
        candidates.append(("service_crash", 0.8, "Container running but health probe failing."))

    # Memory leak: steady growth over the last ~12 s.
    mem_series = [r["memory"] for r in window[-12:] if r.get("memory") is not None]
    if running and len(mem_series) >= 8:
        slope, r2 = linear_fit(mem_series)
        # A freshly restarted process sits below the trained baseline, so growth
        # counts from whichever is lower.
        growth = mem_series[-1] - min(base.get("memory", mem_series[0]), mem_series[0])
        if slope > 0.15 and growth > 5:
            match = clamp(0.45 + 0.35 * clamp(r2) + 0.2 * clamp(slope / 1.0))
            candidates.append(
                ("memory_leak", match, f"Memory +{growth:.1f} pts over baseline, +{slope:.2f} %/s (R² {r2:.2f}).")
            )

    # CPU saturation.
    cpu = avg("cpu")
    if running and cpu > 70:
        match = clamp(0.4 + (cpu - 70) / 30 * 0.6)
        candidates.append(("cpu_saturation", match, f"CPU averaging {cpu:.0f}% of its limit."))

    # Latency spike with a healthy error rate.
    if kind != "cache" and running:
        p95 = avg("latencyP95")
        base_p95 = max(1.0, base.get("latencyP95", p95))
        ratio = p95 / base_p95
        if ratio > 1.5:
            err = avg("errorRate")
            # Slow responses make a few callers time out; only an error rate past
            # the 5% alert rule points at a different fault.
            err_ok = err <= base.get("errorRate", 0.0) + 5.0
            match = 0.5 * clamp(ratio / 3) + 0.5 * clamp(p95 / 500)
            if not err_ok:
                match *= 0.4
            if cpu > 80:
                # Queueing behind a pinned CPU is a symptom, not the fault.
                match *= 0.5
            candidates.append(
                ("latency_spike", clamp(match), f"p95 {p95:.0f} ms vs baseline {base_p95:.0f} ms (×{ratio:.1f}); error rate {err:.1f}%.")
            )

    # Cache saturation.
    if kind == "cache" and running:
        mem = avg("memory")
        hit = avg("hitRate")
        base_hit = base.get("hitRate") or 90.0
        drop = base_hit - hit if hit else 0.0
        if mem > 85:
            match = clamp(0.5 + 0.25 * clamp((mem - 85) / 15) + 0.25 * clamp(drop / 40))
            candidates.append(
                ("cache_saturation", match, f"Cache memory {mem:.0f}% of maxmemory; hit rate {hit:.0f}% (baseline {base_hit:.0f}%).")
            )

    candidates.sort(key=lambda c: c[1], reverse=True)
    if candidates and candidates[0][1] >= decision_threshold:
        fault, match, evidence = candidates[0]
        signature, desc = SIGNATURES[fault]
        return {
            "signature": signature,
            "match": round(match, 2),
            "faultType": fault,
            "summary": f"{desc} {evidence}",
        }

    if candidates:
        fault, match, evidence = candidates[0]
        closest = SIGNATURES[fault][0]
        summary = (
            f"No signature cleared the {decision_threshold:.2f} decision threshold. "
            f"Closest: {closest} at {match:.2f} — {evidence}"
        )
        best = match
    else:
        summary = "Anomalous behaviour with no matching fault signature."
        best = 0.0
    return {"signature": "UNKNOWN", "match": round(best, 2), "faultType": "unknown", "summary": summary}
