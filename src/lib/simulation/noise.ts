/**
 * Realistic telemetry jitter via a bounded, mean-reverting random walk.
 *
 * Each step nudges the value a little way back toward its target (reversion)
 * and adds a small random shock (volatility), then clamps to [min, max]. This
 * produces believable wobble that always hovers around a baseline — no
 * sine-wave fakes, no unbounded drift.
 *
 * A seeded PRNG keeps runs reproducible (useful for tests / fast time-scale
 * demos) and sidesteps Math.random() entirely.
 */

export type Rng = () => number;

/** mulberry32 — tiny, fast, deterministic PRNG in [0, 1). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WalkSpec {
  /** Value the walk reverts toward. */
  target: number;
  /** Lower clamp. */
  min: number;
  /** Upper clamp. */
  max: number;
  /** Pull toward target per step, 0–1 (higher = snappier reversion). */
  reversion: number;
  /** Std-dev-ish magnitude of the random shock, in value units. */
  volatility: number;
}

/**
 * One step of the walk.
 *
 *   next = current + reversion·(target − current) + volatility·shock
 *
 * `shock` is a centred pseudo-gaussian in ~[-1, 1] (average of two uniforms),
 * which keeps big jumps rare without the cost of Box–Muller.
 */
export function walkStep(current: number, rng: Rng, spec: WalkSpec): number {
  const { target, min, max, reversion, volatility } = spec;
  const shock = rng() + rng() - 1; // centred, gentle tails
  const drift = reversion * (target - current);
  const next = current + drift + volatility * shock;
  return clamp(next, min, max);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Round to `dp` decimals (numbers stay tidy for display + comparisons). */
export function round(value: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
