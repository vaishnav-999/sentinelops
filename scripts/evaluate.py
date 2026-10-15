"""Evaluation campaign for the paper: repeated fault injection + healthy soak.

Runs every selected Chaos Lab scenario N times against the live backend
(resetting the environment between trials so guardrails and replicas do not
carry over), then watches a fault-free soak period to measure false positives.
All numbers come from the backend's own records via /api/research/export.

    python scripts/evaluate.py --trials 10 --soak-min 30
    python scripts/evaluate.py --trials 10 --soak-min 30 --config threshold-only
    python scripts/evaluate.py --analyze research/2026-10-16_0130_hybrid

Outputs research/<timestamp>_<config>/:
    runs.csv            one row per trial (ground truth, detections, diagnosis, outcome, timings)
    traces.csv          1 Hz detector trace of the target during every trial
    soak_detections.csv detections during the fault-free soak
    summary.md / .json  tables for the paper (rates with 95% Wilson intervals)
    export.json, meta.json  raw records, so --analyze can recompute later

Standard library only. On a password-protected server pass --user/--password
(and --insecure for a self-signed certificate).
"""

from __future__ import annotations

import argparse
import csv
import http.cookiejar
import json
import math
import platform
import ssl
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

SCENARIOS = [
    "latency-injection", "memory-leak", "cpu-spike", "service-crash", "cache-saturation", "unknown-anomaly",
]
# Relapse trials: the fault returns after the first fix. Reported separately,
# not mixed into the single-fault detection and remediation tables.
RECURRING = ["recurring-leak"]
EXPECTED = {"unknown-anomaly": "escalated", "recurring-leak": "escalated"}
DETECTORS = ("threshold", "ml", "hybrid")
DETECTOR_LABEL = {"threshold": "Static threshold", "ml": "Isolation Forest", "hybrid": "Hybrid (either)"}
FAULT_TYPES = ["latency_spike", "memory_leak", "cpu_saturation", "service_crash", "cache_saturation", "unknown"]
LINK_WINDOW_MS = 300_000


# ------------------------------------------------------------------ http


class Api:
    def __init__(self, base: str, insecure: bool):
        self.base = base.rstrip("/")
        handlers: list = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())]
        if insecure:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        self.opener = urllib.request.build_opener(*handlers)

    def call(self, path: str, body: dict | None = None, method: str | None = None, timeout: float = 15):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path, data=data, method=method or ("GET" if body is None else "POST"),
            headers={"Content-Type": "application/json"},
        )
        with self.opener.open(req, timeout=timeout) as r:
            return json.load(r)


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ------------------------------------------------------------- campaign


def wait_quiet(api: Api, max_sec: int = 240) -> bool:
    """Until no pipeline, no run and no detector currently fired."""
    t0 = time.time()
    while time.time() - t0 < max_sec:
        state = api.call("/api/state")
        active = [i for i in state.get("incidents", []) if i["status"] not in ("resolved", "escalated")]
        services = api.call("/api/ml/status")["services"]
        fired = [s["serviceId"] for s in services if s.get("mlFired") or s.get("thresholdFired")]
        if not active and not fired and state.get("scenarioPhase") in (None, "idle"):
            return True
        time.sleep(2)
    return False


def run_trial(api: Api, scenario: str, target: str, timeout: int, traces: list[dict]) -> dict | None:
    before = {e["id"] for e in api.call("/api/experiments")}
    res = api.call("/api/chaos/inject", {"scenario": scenario})
    if not res.get("accepted", True):
        log(f"  inject refused: {res}")
        return None
    t0 = time.time()
    while time.time() - t0 < timeout:
        state = api.call("/api/state")
        new = [e for e in state["experimentRuns"] if e["id"] not in before]
        det = next((d for d in api.call("/api/ml/status")["services"] if d["serviceId"] == target), None)
        if new and det:
            f = det.get("features") or {}
            traces.append({
                "runId": new[-1]["id"], "tSec": round(time.time() - t0, 1), "score": det.get("score"),
                "effectSigma": det.get("effectSigma"), "mlFired": det.get("mlFired"),
                "thresholdFired": det.get("thresholdFired"), "cpu": f.get("cpu"), "memory": f.get("memory"),
                "memorySlope": f.get("memory_slope"), "latencyP95": f.get("latencyP95"),
                "errorRate": f.get("errorRate"), "throughput": f.get("throughput"),
            })
        done = [e for e in new if e["outcome"] != "running"]
        if done:
            return done[-1]
        time.sleep(1)
    log("  trial timed out")
    return None


def campaign(args) -> Path:
    api = Api(args.base, args.insecure)
    if args.user:
        api.call("/api/auth/login", {"username": args.user, "password": args.password})
    status = api.call("/api/ml/status")
    untrained = [s["serviceId"] for s in status["services"] if not s["trained"]]
    if untrained:
        sys.exit(f"Models still learning the baseline: {', '.join(untrained)}. Wait and retry.")

    scenarios_meta = api.call("/api/scenarios")
    settings_before = api.call("/api/settings")
    run_settings = {"anomalyScan": args.config == "hybrid", "dryRun": False, "autoRemediation": True}
    api.call("/api/settings", run_settings, method="PATCH")

    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    out = Path(args.out) / f"{stamp}_{args.config}"
    out.mkdir(parents=True, exist_ok=True)
    meta = {
        "config": args.config, "trials": args.trials, "scenarios": args.scenarios, "soakMin": args.soak_min,
        "gapSec": args.gap, "base": args.base, "startedAt": int(time.time() * 1000),
        "host": f"{platform.system()} {platform.release()} · Python {platform.python_version()}",
        "commit": git_commit(), "experimentIds": [], "soak": None,
    }
    traces: list[dict] = []
    try:
        order = [s for _ in range(args.trials) for s in args.scenarios]  # interleaved, not blocked
        for i, scenario in enumerate(order, 1):
            target = scenarios_meta[scenario]["target"]
            api.call("/api/system/reset", {})
            # Trials are independent: no trust earned or lost in an earlier one.
            api.call("/api/policies/trust/reset", {})
            time.sleep(args.gap)
            if not wait_quiet(api):
                log("  environment did not settle; running the trial anyway")
            log(f"trial {i}/{len(order)}  {scenario} on {target}")
            exp = run_trial(api, scenario, target, args.timeout, traces)
            if exp:
                meta["experimentIds"].append(exp["id"])
                log(f"  {exp['id']} outcome={exp['outcome']}")
            save(out, meta, traces)

        if args.soak_min > 0:
            api.call("/api/system/reset", {})
            time.sleep(args.gap)
            wait_quiet(api)
            start = int(time.time() * 1000)
            log(f"healthy soak for {args.soak_min} min (no faults injected)")
            time.sleep(args.soak_min * 60)
            meta["soak"] = {"start": start, "end": int(time.time() * 1000)}
    finally:
        api.call("/api/settings", {k: settings_before[k] for k in run_settings}, method="PATCH")
        meta["finishedAt"] = int(time.time() * 1000)
        export = api.call("/api/research/export", timeout=60)
        (out / "export.json").write_text(json.dumps(export), encoding="utf-8")
        save(out, meta, traces)
    return out


def save(out: Path, meta: dict, traces: list[dict]) -> None:
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    write_csv(out / "traces.csv", traces)


def git_commit() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              timeout=5).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


# -------------------------------------------------------------- analysis


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def dist(values: list[float]) -> dict | None:
    if not values:
        return None
    s = sorted(values)
    return {
        "n": len(s), "mean": statistics.fmean(s), "sd": statistics.stdev(s) if len(s) > 1 else 0.0,
        "median": statistics.median(s), "p95": s[min(len(s) - 1, math.ceil(0.95 * len(s)) - 1)],
        "min": s[0], "max": s[-1],
    }


def link_incident(exp: dict, incidents: list[dict]) -> dict | None:
    t0 = exp["injectedAt"]
    cands = [
        i for i in incidents
        if i["serviceId"] == exp["target"] and t0 <= i["detectedAt"] <= t0 + LINK_WINDOW_MS
        and i.get("scenarioId") in (None, exp["scenarioId"])
    ]
    return min(cands, key=lambda i: i["detectedAt"]) if cands else None


def sec(t: int | None, t0: int) -> float | None:
    return None if t is None else round((t - t0) / 1000, 2)


def relapse_summary(rows: list[dict], incidents: list[dict]) -> dict | None:
    """Recurring-fault trials: was the relapse recognised, and did earned trust
    (not a rate limit) stop the second blind restart?"""
    if not rows:
        return None
    by_id = {i["id"]: i for i in incidents}
    first_healed = recognised = trust_stopped = 0
    gaps = []
    for r in rows:
        first = by_id.get(r["incidentId"] or "")
        if first and first["status"] == "resolved":
            first_healed += 1
        second = by_id.get(r["relapseIncidentId"] or "")
        if second and second.get("recurrenceOf") == r["incidentId"]:
            recognised += 1
            if second.get("relapseAfterSec") is not None:
                gaps.append(second["relapseAfterSec"])
            if second.get("outcomeLabel", "").startswith("Policy trust too low"):
                trust_stopped += 1
    n = len(rows)
    return {"n": n, "firstHealed": first_healed, "firstHealedCi": wilson(first_healed, n),
            "relapseRecognised": recognised, "relapseRecognisedCi": wilson(recognised, n),
            "stoppedByTrust": trust_stopped, "stoppedByTrustCi": wilson(trust_stopped, n),
            "fixLastedSec": dist(gaps)}


def blast_summary(exps: list[dict], incidents: list[dict]) -> dict:
    """Downstream symptoms charged to a root incident instead of opening their own."""
    per_fault: dict = {}
    for e in exps:
        if e["scenarioId"] in RECURRING:
            continue
        inc = link_incident(e, incidents)
        n_imp = len((inc or {}).get("impact") or [])
        pf = per_fault.setdefault(e["faultType"], {"trials": 0, "withImpact": 0, "suppressed": 0})
        pf["trials"] += 1
        pf["withImpact"] += 1 if n_imp else 0
        pf["suppressed"] += n_imp
    return per_fault


def analyze(out: Path) -> dict:
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    export = json.loads((out / "export.json").read_text(encoding="utf-8"))
    ids = set(meta["experimentIds"])
    exps = [e for e in export["experiments"] if e["id"] in ids]
    incidents = export["incidents"]

    rows = []
    for e in exps:
        t0 = e["injectedAt"]
        thr, ml = sec(e.get("thresholdDetectedAt"), t0), sec(e.get("mlDetectedAt"), t0)
        hyb = min([x for x in (thr, ml) if x is not None], default=None)
        inc = link_incident(e, incidents)
        diag = (inc or {}).get("diagnosis") or {}
        expected = EXPECTED.get(e["scenarioId"], "auto_healed")
        resolved = inc is not None and inc["status"] == "resolved" and inc.get("resolvedAt")
        rows.append({
            "runId": e["id"], "scenario": e["scenarioId"], "faultType": e["faultType"], "target": e["target"],
            "injectedAt": t0, "thresholdSec": thr, "mlSec": ml, "hybridSec": hyb,
            "incidentId": (inc or {}).get("id"), "diagnosedFault": diag.get("faultType"),
            "signatureMatch": diag.get("match"),
            "diagnosisCorrect": None if inc is None else diag.get("faultType") == e["faultType"],
            "action": (inc or {}).get("action"), "outcome": e["outcome"], "expectedOutcome": expected,
            "handledCorrectly": e["outcome"] == expected,
            "detectToResolveSec": (inc or {}).get("recoverySec") if resolved else None,
            "injectToResolveSec": sec(inc["resolvedAt"], t0) if resolved else None,
            "relapseIncidentId": (inc or {}).get("relapsedBy"),
            "blastRadius": len((inc or {}).get("impact") or []),
        })
    write_csv(out / "runs.csv", rows)
    relapse = relapse_summary([r for r in rows if r["scenario"] in RECURRING], incidents)
    blast = blast_summary(exps, incidents)
    rows = [r for r in rows if r["scenario"] not in RECURRING]

    # ---- detection, per fault type and overall
    detection: dict = {}
    for d in DETECTORS:
        key = f"{d}Sec"
        per_fault = {}
        for ft in FAULT_TYPES:
            sub = [r for r in rows if r["faultType"] == ft]
            if not sub:
                continue
            hits = [r[key] for r in sub if r[key] is not None]
            per_fault[ft] = {"n": len(sub), "detected": len(hits), "ci": wilson(len(hits), len(sub)),
                             "mttd": dist(hits)}
        hits = [r[key] for r in rows if r[key] is not None]
        detection[d] = {"perFault": per_fault, "n": len(rows), "detected": len(hits),
                        "ci": wilson(len(hits), len(rows)), "mttd": dist(hits)}

    # ---- false positives during the soak (service-minute windows)
    soak = meta.get("soak")
    fp: dict = {}
    soak_rows = []
    if soak:
        minutes = int((soak["end"] - soak["start"]) // 60_000)
        services = sorted({s for s in (dd["serviceId"] for dd in export["detections"])} | {
            "api-gateway", "auth-service", "orders-service", "payment-worker", "notification-worker", "redis-cache"})
        windows = minutes * len(services)
        in_soak = [dd for dd in export["detections"]
                   if soak["start"] <= dd["t"] < soak["end"] and not dd.get("runId")]
        for dd in in_soak:
            soak_rows.append({"t": dd["t"], "minute": (dd["t"] - soak["start"]) // 60_000, "kind": dd["kind"],
                              "serviceId": dd["serviceId"], "score": dd.get("score"), "rule": dd.get("rule")})
        for d in DETECTORS:
            kinds = {"threshold"} if d == "threshold" else {"ml"} if d == "ml" else {"threshold", "ml"}
            fired = {(r["serviceId"], r["minute"]) for r in soak_rows if r["kind"] in kinds}
            fp[d] = {"windows": windows, "fpWindows": len(fired), "events": sum(1 for r in soak_rows if r["kind"] in kinds),
                     "fpr": len(fired) / windows if windows else None, "fprCi": wilson(len(fired), windows),
                     "minutes": minutes}
    write_csv(out / "soak_detections.csv", soak_rows)

    # ---- window-based confusion matrix (positives = trials, negatives = soak windows)
    scores: dict = {}
    for d in DETECTORS:
        tp = detection[d]["detected"]
        fn = detection[d]["n"] - tp
        fpw = fp.get(d, {}).get("fpWindows")
        neg = fp.get(d, {}).get("windows")
        if fpw is None or not neg:
            scores[d] = None
            continue
        tn = neg - fpw
        recall = tp / (tp + fn) if tp + fn else None
        precision = tp / (tp + fpw) if tp + fpw else None
        f1 = (2 * precision * recall / (precision + recall)
              if precision is not None and recall is not None and precision + recall else None)
        spec = tn / neg
        scores[d] = {"tp": tp, "fn": fn, "fp": fpw, "tn": tn, "precision": precision, "recall": recall,
                     "f1": f1, "specificity": spec,
                     "balancedAccuracy": (recall + spec) / 2 if recall is not None else None}

    # ---- diagnosis
    diag_rows = [r for r in rows if r["incidentId"]]
    confusion = {ft: {} for ft in FAULT_TYPES}
    for r in diag_rows:
        pred = r["diagnosedFault"] or "none"
        confusion.setdefault(r["faultType"], {})
        confusion[r["faultType"]][pred] = confusion[r["faultType"]].get(pred, 0) + 1
    correct = sum(1 for r in diag_rows if r["diagnosisCorrect"])
    diagnosis = {"n": len(diag_rows), "correct": correct, "ci": wilson(correct, len(diag_rows)),
                 "confusion": confusion}

    # ---- remediation
    remediation = {}
    for ft in FAULT_TYPES + ["all"]:
        sub = rows if ft == "all" else [r for r in rows if r["faultType"] == ft]
        if not sub:
            continue
        ok = sum(1 for r in sub if r["handledCorrectly"])
        remediation[ft] = {
            "n": len(sub), "handledCorrectly": ok, "ci": wilson(ok, len(sub)),
            "detectToResolve": dist([r["detectToResolveSec"] for r in sub if r["detectToResolveSec"] is not None]),
            "injectToResolve": dist([r["injectToResolveSec"] for r in sub if r["injectToResolveSec"] is not None]),
        }

    summary = {"meta": meta, "config": export.get("config"), "detection": detection, "falsePositives": fp,
               "scores": scores, "diagnosis": diagnosis, "remediation": remediation,
               "relapse": relapse, "blastRadius": blast}
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out / "summary.md").write_text(markdown(summary), encoding="utf-8")
    return summary


# -------------------------------------------------------------- markdown


def pct(k: int, n: int, ci) -> str:
    if n == 0:
        return "—"
    s = f"{k}/{n} ({k / n * 100:.0f}%"
    return s + (f", 95% CI {ci[0] * 100:.0f}–{ci[1] * 100:.0f}%)" if ci else ")")


def secs(dd: dict | None) -> str:
    if not dd:
        return "—"
    return f"{dd['median']:.1f} s (mean {dd['mean']:.1f} ± {dd['sd']:.1f}, p95 {dd['p95']:.1f})"


def fnum(v, digits: int = 3) -> str:
    return "—" if v is None else f"{v:.{digits}f}"


def markdown(s: dict) -> str:
    m = s["meta"]
    L = [
        f"# Evaluation — {m['config']}",
        "",
        f"- Trials per scenario: {m['trials']} · scenarios: {', '.join(m['scenarios'])}",
        f"- Soak: {m['soakMin']} min · gap between trials: {m['gapSec']} s · commit {m.get('commit') or 'n/a'}",
        f"- Host: {m['host']} · detector config: `{json.dumps(s.get('config'))}`",
        "- Positives = injected trials; negatives = fault-free service-minutes during the soak.",
        "",
        "## Detection rate and time to detect (from injection)",
        "",
        "| Fault | " + " | ".join(DETECTOR_LABEL[d] for d in DETECTORS) + " |",
        "|---|" + "---|" * len(DETECTORS),
    ]
    for ft in FAULT_TYPES:
        cells = []
        for d in DETECTORS:
            pf = s["detection"][d]["perFault"].get(ft)
            cells.append("—" if not pf else f"{pct(pf['detected'], pf['n'], pf['ci'])}<br>{secs(pf['mttd'])}")
        if any(c != "—" for c in cells):
            L.append(f"| {ft} | " + " | ".join(cells) + " |")
    L.append("| **all** | " + " | ".join(
        f"{pct(s['detection'][d]['detected'], s['detection'][d]['n'], s['detection'][d]['ci'])}<br>"
        f"{secs(s['detection'][d]['mttd'])}" for d in DETECTORS) + " |")

    L += ["", "## Detector quality (window-based)", "",
          "| Detector | TP | FN | FP windows | TN | Precision | Recall | F1 | FPR | Balanced acc. |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for d in DETECTORS:
        sc, fp = s["scores"].get(d), s["falsePositives"].get(d)
        if not sc:
            L.append(f"| {DETECTOR_LABEL[d]} | — | — | — | — | — | — | — | — | — |")
            continue
        L.append(f"| {DETECTOR_LABEL[d]} | {sc['tp']} | {sc['fn']} | {sc['fp']} | {sc['tn']} | "
                 f"{fnum(sc['precision'])} | {fnum(sc['recall'])} | {fnum(sc['f1'])} | "
                 f"{fnum(fp['fpr'], 4)} | {fnum(sc['balancedAccuracy'])} |")

    dg = s["diagnosis"]
    L += ["", "## Diagnosis (signature match vs injected fault)", "",
          f"Accuracy: {pct(dg['correct'], dg['n'], dg['ci'])}", "",
          "| Injected \\ Diagnosed | " + " | ".join(FAULT_TYPES) + " | none |",
          "|---|" + "---|" * (len(FAULT_TYPES) + 1)]
    for ft in FAULT_TYPES:
        row = dg["confusion"].get(ft, {})
        if row:
            L.append(f"| {ft} | " + " | ".join(str(row.get(p, 0)) for p in FAULT_TYPES + ["none"]) + " |")

    L += ["", "## Remediation", "",
          "Correct handling = auto-healed for known faults, escalated for the unknown anomaly.", "",
          "| Fault | Correct handling | Detect → resolved | Inject → resolved |", "|---|---|---|---|"]
    for ft, r in s["remediation"].items():
        L.append(f"| {ft} | {pct(r['handledCorrectly'], r['n'], r['ci'])} | {secs(r['detectToResolve'])} | "
                 f"{secs(r['injectToResolve'])} |")

    L += ["", "## Blast radius (symptoms attributed to the root incident)", "",
          "| Fault | Trials | Trials with downstream symptoms | Incidents not opened |", "|---|---|---|---|"]
    for ft, b in s["blastRadius"].items():
        L.append(f"| {ft} | {b['trials']} | {b['withImpact']} | {b['suppressed']} |")

    rl = s.get("relapse")
    if rl:
        L += ["", "## Relapse and earned autonomy (recurring-leak trials)", "",
              f"- First fault auto-healed: {pct(rl['firstHealed'], rl['n'], rl['firstHealedCi'])}",
              f"- Relapse linked to the earlier fix: {pct(rl['relapseRecognised'], rl['n'], rl['relapseRecognisedCi'])}",
              f"- Second restart withheld by earned trust: {pct(rl['stoppedByTrust'], rl['n'], rl['stoppedByTrustCi'])}",
              f"- Fix lasted: {secs(rl['fixLastedSec'])}"]
    L.append("")
    return "\n".join(L)


# ------------------------------------------------------------------ main


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default="http://127.0.0.1:8000")
    p.add_argument("--trials", type=int, default=5, help="trials per scenario")
    p.add_argument("--scenarios", nargs="+", default=SCENARIOS, choices=SCENARIOS + RECURRING)
    p.add_argument("--soak-min", type=int, default=20, help="fault-free minutes for the false-positive rate")
    p.add_argument("--gap", type=int, default=20, help="seconds to settle after each reset")
    p.add_argument("--timeout", type=int, default=300, help="max seconds per trial")
    p.add_argument("--config", choices=["hybrid", "threshold-only"], default="hybrid",
                   help="threshold-only disables the Isolation Forest for a rule-based baseline")
    p.add_argument("--out", default="research")
    p.add_argument("--user")
    p.add_argument("--password")
    p.add_argument("--insecure", action="store_true", help="accept a self-signed certificate")
    p.add_argument("--analyze", metavar="DIR", help="only recompute the summary for an existing run folder")
    args = p.parse_args()

    try:
        out = Path(args.analyze) if args.analyze else campaign(args)
    except urllib.error.URLError as exc:
        sys.exit(f"Backend not reachable at {args.base}: {exc}")
    analyze(out)
    print(f"\nWrote {out / 'summary.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
