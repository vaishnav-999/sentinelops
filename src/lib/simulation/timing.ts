import type { Rng } from "./noise";

/**
 * Per-run timing.
 *
 * The demo is judged on two numbers — how fast the anomaly detector fires and
 * how fast the system is back to healthy — so a run must be able to *quote*
 * them rather than have them baked into the scenario script. Every run mints a
 * `RunTiming`; the engine time-warps the scenario timeline onto it and every
 * surface (toasts, island, run console, incident, terminal) reads the same
 * values back out.
 *
 * The first run after page load or Reset Demo uses the baseline exactly, so the
 * walkthrough matches the slides. Later runs are drawn from the ranges below,
 * which is what stops the Experiment Runs table looking hardcoded.
 */

export interface RunTiming {
  /** Seconds after injection the anomaly detector fires. */
  mlDetectSec: number;
  /**
   * Seconds after the anomaly detector that the static threshold rule
   * confirms. The rule still needs the metric to genuinely be over its
   * threshold; this is the evaluation interval + hold-down it waits out first.
   */
  thresholdDelaySec: number;
  /** Detection → resolved, seconds. */
  recoverySec: number;
}

/** The numbers on the slides. Run #1 after load/reset reproduces these exactly. */
export const BASELINE_TIMING: RunTiming = {
  mlDetectSec: 8.2,
  thresholdDelaySec: 3.4,
  recoverySec: 18.4,
};

/** Inclusive [min, max] draw ranges for every run after the first. */
export const TIMING_RANGE = {
  mlDetectSec: [7.4, 9.2],
  thresholdDelaySec: [3, 6],
  recoverySec: [16.5, 20.5],
} as const satisfies Record<keyof RunTiming, readonly [number, number]>;

/** Uniform draw in [min, max], rounded to one decimal. */
function draw(rng: Rng, [min, max]: readonly [number, number]): number {
  return Math.round((min + rng() * (max - min)) * 10) / 10;
}

export function nominalTiming(): RunTiming {
  return { ...BASELINE_TIMING };
}

export function jitteredTiming(rng: Rng): RunTiming {
  return {
    mlDetectSec: draw(rng, TIMING_RANGE.mlDetectSec),
    thresholdDelaySec: draw(rng, TIMING_RANGE.thresholdDelaySec),
    recoverySec: draw(rng, TIMING_RANGE.recoverySec),
  };
}

/**
 * How a scenario's own script maps onto a run's timing.
 *
 * `detect` scales everything up to the detection step; `recover` scales the
 * detection → end stretch. Scenarios whose nominal numbers differ from the
 * memory-leak headline (the four short faults detect at +6 s) keep their own
 * character and simply move by the same proportion.
 */
export interface TimeWarp {
  detect: number;
  recover: number;
}

export function warpFactors(timing: RunTiming): TimeWarp {
  return {
    detect: timing.mlDetectSec / BASELINE_TIMING.mlDetectSec,
    recover: timing.recoverySec / BASELINE_TIMING.recoverySec,
  };
}

/**
 * The timing a specific scenario actually runs at, once the drawn factors have
 * been applied to its own script. For the memory-leak headline this reproduces
 * the drawn numbers exactly; the shorter faults land proportionally.
 */
export function scenarioTiming(
  nominal: { detectAtMs: number; endAtMs: number },
  warp: TimeWarp,
  thresholdDelaySec: number,
): RunTiming {
  const round1 = (ms: number) => Math.round(ms / 100) / 10;
  return {
    mlDetectSec: round1(nominal.detectAtMs * warp.detect),
    thresholdDelaySec,
    recoverySec: round1((nominal.endAtMs - nominal.detectAtMs) * warp.recover),
  };
}
