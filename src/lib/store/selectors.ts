import type { ClusterMetrics, IslandState, Service } from "@/lib/types";
import { COUNTS } from "@/lib/mock-data/constants";
import { aggregateCluster } from "@/lib/simulation/telemetry";
import type { MetricKey } from "@/lib/simulation/thresholds";

/**
 * Pure read-models over the store. Components stay dumb: they select state and
 * hand it to these, which keeps the derived copy in one testable place.
 */

/** The store-driven half of the page-header greeting (SPEC §8). */
export function headlineSentence(island: IslandState): string {
  switch (island) {
    case "operational":
      return "Production is healthy.";
    case "anomaly":
    case "diagnosing":
      return "SentinelOps detected abnormal behaviour.";
    case "healing":
    case "verifying":
      return "Auto-healing in progress.";
    case "recovered":
      return "Recovered — production is healthy.";
    case "escalated":
      return "Escalated — awaiting operator approval.";
  }
}

/** "Good morning." / "Good afternoon." / "Good evening." from the local clock. */
export function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

/** "Monitoring 6 services · 8 containers · 1 database · 1 cache". */
export function monitoringSubtitle(): string {
  const parts = [
    `${COUNTS.services} services`,
    `${COUNTS.containers} containers`,
    `${COUNTS.databases} database`,
    `${COUNTS.caches} cache`,
  ];
  return `Monitoring ${parts.join(" · ")}`;
}

/**
 * Reads a chartable metric off a cluster snapshot. The aggregate calls HTTP
 * traffic `requestsPerMin`, while a per-service sample calls it `throughput`.
 */
export function clusterValue(c: ClusterMetrics, key: MetricKey): number {
  return key === "throughput" ? c.requestsPerMin : c[key];
}

export interface TrailDelta {
  /** current − past, in the metric's own unit. */
  change: number;
  /** How far back the comparison actually reaches, in seconds. */
  windowSec: number;
}

/**
 * Change against the oldest sample in the coarse trail. The trail is capped at
 * a 5-minute window, so this reads "vs 5 min ago" once warm and honestly
 * reports a shorter window in the first few minutes after a reset.
 */
export function trailDelta(
  trail: ClusterMetrics[],
  current: ClusterMetrics,
  pick: (c: ClusterMetrics) => number,
): TrailDelta | null {
  const oldest = trail[0];
  if (!oldest || oldest.t >= current.t) return null;
  return {
    change: pick(current) - pick(oldest),
    windowSec: (current.t - oldest.t) / 1000,
  };
}

/**
 * The cluster aggregate the services would report if every one of them sat
 * exactly on its seeded baseline — the centre of the learned-baseline band.
 */
export function clusterBaseline(services: Service[]): ClusterMetrics {
  return aggregateCluster(
    0,
    services.map((s) => ({ ...s, metrics: s.baseline })),
    0,
  );
}

/** Count of services in a hard-failed state, for the nucleus stat row. */
export function criticalCount(services: Service[]): number {
  return services.filter((s) => s.status === "critical").length;
}
