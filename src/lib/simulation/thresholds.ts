import type { Service } from "@/lib/types";

/**
 * Alerting thresholds and learned-baseline envelopes.
 *
 * The same numbers serve two jobs: the dashed warn line on the telemetry chart
 * (evaluated against the cluster aggregate) and the breach dots on the metrics
 * strip (evaluated per service, because one hot service is what an operator
 * actually needs to see — a six-service mean hides it).
 */

/** Chartable metric keys shared by MetricSample and the cluster aggregate. */
export type MetricKey =
  | "cpu"
  | "memory"
  | "latencyP95"
  | "errorRate"
  | "throughput";

export interface MetricThreshold {
  value: number;
  /** "above" = breach when the metric climbs past `value`, "below" = falls under. */
  direction: "above" | "below";
  /** Direct chart label — no legends anywhere. */
  label: string;
}

export const METRIC_THRESHOLDS: Record<MetricKey, MetricThreshold> = {
  cpu: { value: 85, direction: "above", label: "Warn 85%" },
  memory: { value: 90, direction: "above", label: "Warn 90%" },
  latencyP95: { value: 500, direction: "above", label: "Warn 500 ms" },
  errorRate: { value: 5, direction: "above", label: "Warn 5%" },
  throughput: { value: 9000, direction: "below", label: "Floor 9,000 rpm" },
};

/** Uptime below this is a breach on the metrics strip. */
export const UPTIME_THRESHOLD = 99.9;

/**
 * Half-width of the learned-baseline band, as a fraction of the baseline value.
 * Wider where the noise walk is naturally wilder (errors, latency).
 */
const BASELINE_TOLERANCE: Record<MetricKey, number> = {
  cpu: 0.1,
  memory: 0.07,
  latencyP95: 0.14,
  errorRate: 0.4,
  throughput: 0.06,
};

export interface BaselineBand {
  low: number;
  high: number;
}

/**
 * The envelope the walk normally stays inside, derived from the seeded service
 * baselines — the simulation's stand-in for a model learned over a 24h window.
 */
export function baselineBand(center: number, key: MetricKey): BaselineBand {
  const half = center * BASELINE_TOLERANCE[key];
  return { low: Math.max(0, center - half), high: center + half };
}

function breaches(value: number, t: MetricThreshold): boolean {
  return t.direction === "above" ? value > t.value : value < t.value;
}

/** Ids of the services currently past this metric's threshold. */
export function breachingServices(
  services: Service[],
  key: MetricKey,
): string[] {
  // Throughput is only meaningful in aggregate: a single worker's job rate has
  // no shared floor, so per-service breach detection would be noise.
  if (key === "throughput") return [];
  const t = METRIC_THRESHOLDS[key];
  return services.filter((s) => breaches(s.metrics[key], t)).map((s) => s.id);
}

export function clusterBreaches(value: number, key: MetricKey): boolean {
  return breaches(value, METRIC_THRESHOLDS[key]);
}
