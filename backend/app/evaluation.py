"""Research evaluation computed only from recorded experiments.

Ground truth = Chaos Lab injections (known start, type and target).
  * TP  run where the Isolation Forest fired on the target before the run ended
  * FN  finished run where it never fired
  * FP  Isolation Forest firing outside every run window
  * FPR false-positive monitoring windows / all healthy monitoring windows
        (one window = one service-minute with no chaos run active)
  * MTTD improvement = (mean threshold MTTD − mean ML MTTD) / mean threshold MTTD,
        over runs where both detectors fired
  * MTTR improvement has no manual baseline in this system, so it stays null.

Every value stays null until enough runs exist to make it meaningful.
"""

from __future__ import annotations

from . import config


def compute(experiments: list[dict], detections: list[dict], healthy_windows: int, fp_windows: int) -> dict:
    finished = [e for e in experiments if e["outcome"] in ("auto_healed", "escalated", "failed")]
    result = {
        "precision": None,
        "recall": None,
        "f1": None,
        "falsePositiveRate": None,
        "mttdImprovement": None,
        "mttrImprovement": None,
        "runs": len(finished),
        "minRuns": config.MIN_RUNS_FOR_EVALUATION,
        "falsePositives": 0,
        "healthyWindows": healthy_windows,
    }
    if len(finished) < config.MIN_RUNS_FOR_EVALUATION:
        return result

    tp = sum(1 for e in finished if e.get("mlDetectedAt") is not None)
    fn = len(finished) - tp
    fp = sum(1 for d in detections if d.get("kind") == "ml" and not d.get("runId"))
    result["falsePositives"] = fp

    recall = tp / (tp + fn) if tp + fn else None
    precision = tp / (tp + fp) if tp + fp else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall > 0
        else None
    )
    result["recall"] = round(recall, 3) if recall is not None else None
    result["precision"] = round(precision, 3) if precision is not None else None
    result["f1"] = round(f1, 3) if f1 is not None else None
    if healthy_windows >= 30:
        result["falsePositiveRate"] = round(fp_windows / healthy_windows, 4)

    paired = [
        e for e in finished
        if e.get("mlDetectedAt") is not None and e.get("thresholdDetectedAt") is not None
    ]
    if len(paired) >= config.MIN_PAIRED_RUNS_FOR_MTTD:
        ml = sum(e["mlDetectedAt"] - e["injectedAt"] for e in paired) / len(paired)
        thr = sum(e["thresholdDetectedAt"] - e["injectedAt"] for e in paired) / len(paired)
        if thr > 0:
            result["mttdImprovement"] = round((thr - ml) / thr * 100, 1)
    return result
