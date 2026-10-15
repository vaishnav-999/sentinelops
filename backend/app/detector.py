"""Stage 1 — detection.

Per service:
  * an Isolation Forest trained on that service's own healthy samples.
    It outputs an anomaly score only; it never names a fault.
  * the static threshold rules (the conventional-alerting baseline).

Features: each metric is z-scored against the healthy mean with per-feature
std floors (so a perfectly flat metric does not make every wobble look
infinite), then made one-sided — only the degrading direction counts (CPU,
memory, memory growth, latency and errors going up; throughput going down).
Lower latency or fewer errors are never an incident. A small fixed-seed jitter
(TRAIN_JITTER σ) is added to the training matrix only, so metrics that are
constant while healthy — error rate is 0 — still get split points.

Firing needs both the forest and an effect size: the score must hold at or
above ML_FIRE_SCORE while at least one metric is ML_MIN_EFFECT_Z σ worse than
baseline and also worse by a meaningful amount in its own units (see
min_meaningful_change), for ML_CONSECUTIVE_TO_FIRE samples. The forest says "unusual"; the
gate says "materially worse", which keeps healthy drift from paging anyone.

Scoring: the forest is fitted by scikit-learn, but path lengths are computed
range-aware. A standard Isolation Forest only knows split points inside its
training range, so a value 100σ out follows the same path as the most extreme
healthy sample. Here, at each split node, a point lying a distance d outside
the node's training range [lo, hi] is isolated by that node's uniform random
split with probability d / (hi − lo + d) — the isolation that split would have
given had the point been in the sample. Inside the range this equals
scikit-learn's score_samples.

Normalisation: raw = 2^(−E[h] / c(ψ)). On the healthy training set the median
maps to 0.10 and the 99th percentile to 0.50.

Fitting runs on a background thread so a retrain never stalls the 1 Hz loop;
the previous fit keeps scoring until the new one is swapped in.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from dataclasses import dataclass, field

import numpy as np
from sklearn.ensemble import IsolationForest

from . import config
from .catalog import THRESHOLD_RULES

log = logging.getLogger("sentinel.detector")

FEATURES = ["cpu", "memory", "memory_slope", "latencyP95", "errorRate", "throughput"]
FEATURE_LABELS = {
    "cpu": "CPU",
    "memory": "Memory",
    "memory_slope": "Memory Growth",
    "latencyP95": "Latency",
    "errorRate": "Error Rate",
    "throughput": "Throughput",
}

TRAIN_JITTER = 0.25
# Bump when FEATURES or their units change, so saved baselines are discarded.
BASELINE_VERSION = 1
_EULER = 0.5772156649
# +1: higher is worse; −1: lower is worse (throughput).
_WORSE = np.array([1.0, 1.0, 1.0, 1.0, 1.0, -1.0])


def degradation(z: np.ndarray) -> np.ndarray:
    return np.maximum(z * _WORSE, 0.0)


def min_meaningful_change(mean: np.ndarray) -> np.ndarray:
    """Smallest worsening, in metric units, that can count toward the effect gate.

    A statistically unusual move can still be operationally trivial (a worker's
    p95 going 16 → 48 ms); those never page anyone.
    """
    return np.array([
        15.0,                     # cpu, percentage points
        5.0,                      # memory, percentage points
        0.5,                      # memory growth, % per 10 s
        75.0,                     # p95 latency, ms
        2.0,                      # error rate, percentage points
        max(0.25 * mean[5], 1.0), # throughput drop, 25 % of baseline
    ])


def std_floor(feature: str, mean: float) -> float:
    if feature == "cpu":
        return 3.0
    if feature == "memory":
        return 1.5
    if feature == "memory_slope":
        return 0.5
    if feature == "latencyP95":
        return max(5.0, abs(mean) * 0.15)
    if feature == "errorRate":
        return 0.75
    if feature == "throughput":
        return max(10.0, abs(mean) * 0.15)
    return 1.0


def avg_path_length(n: np.ndarray | int) -> np.ndarray:
    """c(n): mean unsuccessful-search path length in a BST of n points."""
    n = np.asarray(n, dtype=float)
    out = np.zeros_like(n)
    out[n == 2] = 1.0
    big = n > 2
    out[big] = 2.0 * (np.log(n[big] - 1.0) + _EULER) - 2.0 * (n[big] - 1.0) / n[big]
    return out


@dataclass(frozen=True)
class _Forest:
    """All trees padded into (n_trees, max_nodes) arrays for vectorised scoring."""

    left: np.ndarray
    right: np.ndarray
    feature: np.ndarray  # index into FEATURES (not the tree's feature subset)
    threshold: np.ndarray
    lo: np.ndarray
    hi: np.ndarray
    leaf_c: np.ndarray
    max_depth: int
    c_psi: float


def _compile(model: IsolationForest, z: np.ndarray) -> _Forest:
    estimators = model.estimators_
    n_trees = len(estimators)
    width = max(e.tree_.node_count for e in estimators)
    left = np.full((n_trees, width), -1, dtype=np.intp)
    right = np.full((n_trees, width), -1, dtype=np.intp)
    feature = np.zeros((n_trees, width), dtype=np.intp)
    threshold = np.zeros((n_trees, width))
    lo = np.zeros((n_trees, width))
    hi = np.zeros((n_trees, width))
    leaf_c = np.zeros((n_trees, width))

    for i, (est, feats, samples) in enumerate(
        zip(estimators, model.estimators_features_, model.estimators_samples_)
    ):
        t = est.tree_
        n = t.node_count
        feats = np.asarray(feats)
        internal = t.children_left != -1
        left[i, :n] = t.children_left
        right[i, :n] = t.children_right
        feature[i, :n] = np.where(internal, feats[np.maximum(t.feature, 0)], 0)
        threshold[i, :n] = t.threshold
        leaf_c[i, :n] = avg_path_length(t.n_node_samples)
        idx = np.nonzero(internal)[0]
        if idx.size:
            xs = z[samples][:, feats].astype(np.float32)
            path = est.decision_path(xs).toarray().astype(bool)[:, idx]
            vals = xs[:, t.feature[idx]].astype(float)
            lo[i, idx] = np.where(path, vals, np.inf).min(axis=0)
            hi[i, idx] = np.where(path, vals, -np.inf).max(axis=0)

    return _Forest(
        left=left,
        right=right,
        feature=feature,
        threshold=threshold,
        lo=lo,
        hi=hi,
        leaf_c=leaf_c,
        max_depth=max(e.tree_.max_depth for e in estimators),
        c_psi=float(avg_path_length(model.max_samples_)),
    )


def _raw_scores(forest: _Forest, z: np.ndarray) -> np.ndarray:
    """2^(−E[h]/c(ψ)) with range-aware expected path length, one per row of z."""
    zf = z.astype(np.float32).astype(float)
    n = len(zf)
    n_trees = forest.left.shape[0]
    ti = np.arange(n_trees)[:, None]
    pi = np.arange(n)[None, :]
    node = np.zeros((n_trees, n), dtype=np.intp)
    depth = np.zeros((n_trees, n))
    expected = np.zeros((n_trees, n))
    survive = np.ones((n_trees, n))

    for _ in range(forest.max_depth + 1):
        left = forest.left[ti, node]
        internal = left != -1
        if not internal.any():
            break
        v = zf[pi, forest.feature[ti, node]]
        lo = forest.lo[ti, node]
        hi = forest.hi[ti, node]
        gap = np.maximum(lo - v, 0.0) + np.maximum(v - hi, 0.0)
        span = hi - lo + gap
        p = np.divide(gap, span, out=np.zeros_like(gap), where=internal & (span > 0))
        expected += survive * p * (depth + 1.0)
        survive *= 1.0 - p
        nxt = np.where(v <= forest.threshold[ti, node], left, forest.right[ti, node])
        node = np.where(internal, nxt, node)
        depth += internal

    expected += survive * (depth + forest.leaf_c[ti, node])
    return np.power(2.0, -expected.mean(axis=0) / forest.c_psi)


@dataclass(frozen=True)
class _Fit:
    forest: _Forest
    mean: np.ndarray
    std: np.ndarray
    median: float
    p99: float
    samples: int

    def score(self, x: np.ndarray) -> tuple[float, np.ndarray, float]:
        """Normalised score, the one-sided degradation vector (σ units) and the
        effect size: the largest σ among features that also moved by a
        meaningful amount in metric units."""
        s = degradation((x - self.mean) / self.std)
        raw = float(_raw_scores(self.forest, s.reshape(1, -1))[0])
        span = max(self.p99 - self.median, 1e-3)
        score = 0.1 + 0.4 * (raw - self.median) / span
        worse_by = (x - self.mean) * _WORSE
        meaningful = worse_by >= min_meaningful_change(self.mean)
        effect = float(s[meaningful].max()) if meaningful.any() else 0.0
        return float(min(1.0, max(0.0, score))), s, effect


def fit_detector(data: np.ndarray) -> _Fit:
    mean = data.mean(axis=0)
    std = data.std(axis=0)
    floors = np.array([std_floor(f, mean[i]) for i, f in enumerate(FEATURES)])
    std = np.maximum(std, floors)
    z = degradation((data - mean) / std)
    rng = np.random.default_rng(7)
    z_train = z + rng.normal(0.0, TRAIN_JITTER, z.shape)
    model = IsolationForest(n_estimators=150, contamination="auto", random_state=7)
    model.fit(z_train)
    forest = _compile(model, z_train)
    raw = _raw_scores(forest, z)
    return _Fit(
        forest=forest,
        mean=mean,
        std=std,
        median=float(np.median(raw)),
        p99=float(np.percentile(raw, 99)),
        samples=len(data),
    )


@dataclass
class Verdict:
    score: float
    trained: bool
    ml_fired: bool
    ml_edge: bool
    thr_fired: bool
    thr_edge: bool
    thr_rule: str | None
    contributions: list[dict]
    features: dict


@dataclass
class ServiceDetector:
    service_id: str
    healthy: deque = field(default_factory=lambda: deque(maxlen=1800))
    mem_trail: deque = field(default_factory=lambda: deque(maxlen=11))
    fit: _Fit | None = None
    since_train: int = 0
    ml_consec: int = 0
    ml_clear_consec: int = 0
    ml_fired: bool = False
    thr_consec: dict = field(default_factory=dict)
    thr_fired: bool = False
    thr_rule: str | None = None
    last_score: float = 0.0
    last_effect: float = 0.0
    _training: bool = False

    @property
    def trained(self) -> bool:
        return self.fit is not None

    def degraded(self) -> bool:
        """Currently worse than baseline by either detector, even if not yet fired."""
        return (
            self.ml_fired
            or self.thr_fired
            or self.ml_consec > 0
            or any(v > 0 for v in self.thr_consec.values())
        )

    def baseline(self) -> dict | None:
        if self.fit is None:
            if len(self.healthy) >= 20:
                arr = np.array(self.healthy)
                return {f: float(arr[:, i].mean()) for i, f in enumerate(FEATURES)}
            return None
        return {f: float(self.fit.mean[i]) for i, f in enumerate(FEATURES)}

    def _vector(self, m: dict, t: float) -> np.ndarray:
        self.mem_trail.append((t, m["memory"]))
        t0, m0 = self.mem_trail[0]
        dt = t - t0
        slope = (m["memory"] - m0) / dt * 10 if dt >= 3 else 0.0  # % per 10 s
        return np.array(
            [m["cpu"], m["memory"], slope, m["latencyP95"], m["errorRate"], m["throughput"]],
            dtype=float,
        )

    def export_baseline(self) -> dict:
        return {"version": BASELINE_VERSION, "samples": list(self.healthy)}

    def restore_baseline(self, saved: object) -> bool:
        """Reload healthy samples saved before a restart; trains synchronously."""
        if not isinstance(saved, dict) or saved.get("version") != BASELINE_VERSION:
            return False
        samples = saved.get("samples")
        if not isinstance(samples, list) or not all(
            isinstance(s, list) and len(s) == len(FEATURES) for s in samples
        ):
            return False
        self.healthy.extend(samples)
        if len(self.healthy) >= config.WARMUP_SAMPLES:
            self.fit = fit_detector(np.array(self.healthy, dtype=float))
            self.since_train = 0
            log.info("%s: model restored from %d saved healthy samples", self.service_id, len(self.healthy))
        return True

    def _maybe_train(self) -> None:
        if self._training:
            return
        due = (
            len(self.healthy) >= config.WARMUP_SAMPLES
            if self.fit is None
            else self.since_train >= config.RETRAIN_EVERY_SAMPLES
        )
        if not due:
            return
        data = np.array(self.healthy, dtype=float)
        self._training = True
        self.since_train = 0
        threading.Thread(target=self._train_worker, args=(data,), daemon=True).start()

    def _train_worker(self, data: np.ndarray) -> None:
        try:
            self.fit = fit_detector(data)
            log.info("%s: model trained on %d healthy samples", self.service_id, len(data))
        except Exception:  # noqa: BLE001
            log.exception("%s: training failed", self.service_id)
        finally:
            self._training = False

    def observe(self, metrics: dict, t: float, eligible_for_training: bool, in_grace: bool) -> Verdict:
        x = self._vector(metrics, t)
        features = dict(zip(FEATURES, (round(float(v), 2) for v in x)))

        if eligible_for_training and not in_grace and not self.ml_fired and not self.thr_fired:
            self.healthy.append(x.tolist())
            self.since_train += 1
        self._maybe_train()

        # --- ML
        score = 0.0
        effect = 0.0
        contributions: list[dict] = []
        fit = self.fit
        if fit is not None:
            score, dev, effect = fit.score(x)
            total = float(dev.sum())
            if total > 0:
                shares = dev / total * 100
                order = np.argsort(-shares)
                contributions = [
                    {"feature": FEATURE_LABELS[FEATURES[i]], "weight": int(round(shares[i]))}
                    for i in order[:5]
                    if shares[i] >= 0.5
                ]
        self.last_score = score
        self.last_effect = effect

        ml_edge = False
        if in_grace:
            self.ml_consec = 0
        elif score >= config.ML_FIRE_SCORE and effect >= config.ML_MIN_EFFECT_Z:
            self.ml_consec += 1
            self.ml_clear_consec = 0
            if not self.ml_fired and self.ml_consec >= config.ML_CONSECUTIVE_TO_FIRE:
                self.ml_fired = True
                ml_edge = True
        else:
            self.ml_consec = 0
            if self.ml_fired:
                if score < config.ML_CLEAR_SCORE or effect < config.ML_MIN_EFFECT_Z:
                    self.ml_clear_consec += 1
                    if self.ml_clear_consec >= config.CONSECUTIVE_TO_FIRE:
                        self.ml_fired = False
                        self.ml_clear_consec = 0
                else:
                    self.ml_clear_consec = 0

        # --- static thresholds
        thr_edge = False
        breached_rule = None
        for key, limit, label in THRESHOLD_RULES:
            if metrics.get(key, 0) > limit and not in_grace:
                self.thr_consec[label] = self.thr_consec.get(label, 0) + 1
                if self.thr_consec[label] >= config.CONSECUTIVE_TO_FIRE and breached_rule is None:
                    breached_rule = label
            else:
                self.thr_consec[label] = 0
        if breached_rule and not self.thr_fired:
            self.thr_fired = True
            self.thr_rule = breached_rule
            thr_edge = True
        elif not breached_rule and self.thr_fired and not any(self.thr_consec.values()):
            self.thr_fired = False
            self.thr_rule = None

        return Verdict(
            score=round(score, 2),
            trained=self.fit is not None,
            ml_fired=self.ml_fired,
            ml_edge=ml_edge,
            thr_fired=self.thr_fired,
            thr_edge=thr_edge,
            thr_rule=self.thr_rule or breached_rule,
            contributions=contributions,
            features=features,
        )

    def container_restarted(self) -> None:
        """A verdict about the previous process is stale: a fault still present
        in the new one must fire again as a fresh edge."""
        self.ml_consec = 0
        self.ml_clear_consec = 0
        self.ml_fired = False

    def reset_state(self) -> None:
        self.ml_consec = 0
        self.ml_clear_consec = 0
        self.ml_fired = False
        self.thr_consec = {}
        self.thr_fired = False
        self.thr_rule = None
        self.mem_trail.clear()
