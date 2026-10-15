"""End-to-end check of one Chaos Lab scenario against the live backend.

Injects the scenario, follows the pipeline once a second, then prints the run
record, the incident stages and the remediation terminal. Standard library
only. The backend must run without a password (laptop mode) — on a server,
use the console instead.

    python scripts/chaos-check.py latency-injection
    python scripts/chaos-check.py memory-leak --base http://127.0.0.1:8000
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request

SCENARIOS = [
    "memory-leak", "unknown-anomaly", "cpu-spike", "service-crash", "latency-injection", "cache-saturation",
]


def call(base: str, path: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path, data=data, method="GET" if body is None else "POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", choices=SCENARIOS)
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    base = args.base.rstrip("/")

    target = call(base, "/api/scenarios")[args.scenario]["target"]
    before = {e["id"] for e in call(base, "/api/experiments")}
    print("inject:", call(base, "/api/chaos/inject", {"scenario": args.scenario}))

    t0 = time.time()
    run = None
    last_phase = None
    while time.time() - t0 < args.timeout:
        state = call(base, "/api/state")
        det = next((d for d in call(base, "/api/ml/status")["services"] if d["serviceId"] == target), {})
        phase = state.get("scenarioPhase")
        if phase != last_phase:
            f = det.get("features") or {}
            print(f"{time.time() - t0:6.1f}s  {phase:<13} ml={det.get('score')} effect={det.get('effectSigma')}"
                  f" cpu={f.get('cpu')} mem={f.get('memory')} p95={f.get('latencyP95')} err={f.get('errorRate')}")
            last_phase = phase
        done = [e for e in state["experimentRuns"] if e["id"] not in before and e["outcome"] != "running"]
        if done:
            run = done[-1]
            break
        time.sleep(1)

    if run is None:
        print("TIMEOUT: run did not finish")
        return 1
    inj = run["injectedAt"]
    sec = lambda t: None if t is None else round((t - inj) / 1000, 1)  # noqa: E731
    print(f"\nRUN {run['id']} outcome={run['outcome']} threshold@{sec(run.get('thresholdDetectedAt'))}s "
          f"ml@{sec(run.get('mlDetectedAt'))}s remediated@{sec(run.get('remediatedAt'))}s")

    time.sleep(2)
    inc = next((i for i in call(base, "/api/incidents") if i["serviceId"] == target and i["detectedAt"] >= inj), None)
    if inc:
        print(f"INCIDENT {inc['id']} {inc['status']} — {inc['title']} — action: {inc.get('action')}")
        for st in inc["stages"]:
            if st["status"] != "pending":
                print(f"   {st['stage']:<13} {st['status']:<9} {st.get('detail') or ''}")
    exe = call(base, "/api/state")["executions"]
    if exe and inc and exe[-1].get("incidentId") == inc["id"]:
        print("TERMINAL")
        for line in exe[-1].get("lines", [])[-10:]:
            print("   |", line["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
