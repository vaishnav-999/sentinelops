import type { MetricKey } from "@/lib/simulation/thresholds";

/**
 * Display rules for the chartable metrics: one place decides how many decimals
 * a number gets and which direction is bad, so the metrics strip, the telemetry
 * axis and the tooltips can never drift apart.
 */

export interface MetricMeta {
  /** Sentence-case label, per the locked design system. */
  label: string;
  unit: string;
  decimals: number;
  /** False for throughput: more traffic is good news, less is not. */
  higherIsWorse: boolean;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  cpu: { label: "CPU", unit: "%", decimals: 1, higherIsWorse: true },
  memory: { label: "Memory", unit: "%", decimals: 1, higherIsWorse: true },
  latencyP95: {
    label: "P95 latency",
    unit: "ms",
    decimals: 0,
    higherIsWorse: true,
  },
  errorRate: { label: "Error rate", unit: "%", decimals: 2, higherIsWorse: true },
  throughput: {
    label: "Requests/min",
    unit: "rpm",
    decimals: 0,
    higherIsWorse: false,
  },
};

/** 12,043 → "12.0K". Keeps the 24px metric slot from reflowing. */
export function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return Math.round(value).toString();
}

export function formatMetricValue(value: number, key: MetricKey): string {
  if (key === "throughput") return formatCompactNumber(value);
  return value.toFixed(METRIC_META[key].decimals);
}

/** Axis ticks stay terse: no decimals unless the range is genuinely tiny. */
export function formatAxisValue(value: number, key: MetricKey): string {
  if (key === "throughput") return formatCompactNumber(value);
  if (key === "errorRate") return value.toFixed(1);
  return Math.round(value).toString();
}

/**
 * Explicit hh:mm:ss from the engine clock. Deliberately not
 * toLocaleTimeString: locale formatting differs between server and client.
 */
export function formatClockTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** 300 → "5m", 40 → "40s". Used to label how far back a delta reaches. */
export function formatWindow(seconds: number): string {
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

/** Whole hours/days of uptime from a container start time. */
export function formatUptimeSince(startedAt: number, now: number): string {
  const hours = Math.max(0, Math.floor((now - startedAt) / 3_600_000));
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h`;
}
