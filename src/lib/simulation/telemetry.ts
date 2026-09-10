import type {
  ClusterMetrics,
  MetricSample,
  Service,
  ServiceMetrics,
} from "@/lib/types";
import { clamp, round, walkStep, type Rng } from "./noise";
import { computeHealthScore, servicesOnline } from "./health";

/**
 * Advances live telemetry one tick.
 *
 * Each metric performs an independent mean-reverting walk toward a *target*.
 * Targets normally equal the service baseline, but a running scenario can
 * shift them (e.g. ramp payment-worker memory up during a leak), and the noise
 * keeps wobbling realistically around whatever the current target is.
 */

/** Per-metric walk tuning, derived from the current target value. */
function metricSpec(key: keyof ServiceMetrics, target: number) {
  switch (key) {
    case "cpu":
      return { target, min: 0, max: 100, reversion: 0.22, volatility: 1.6 };
    case "memory":
      return { target, min: 0, max: 100, reversion: 0.18, volatility: 0.9 };
    case "latencyP95":
      return {
        target,
        min: 3,
        max: 5000,
        reversion: 0.24,
        volatility: Math.max(2, target * 0.045),
      };
    case "errorRate":
      return { target, min: 0, max: 100, reversion: 0.3, volatility: 0.05 };
    case "throughput":
      return {
        target,
        min: 0,
        max: Number.POSITIVE_INFINITY,
        reversion: 0.2,
        volatility: Math.max(1, target * 0.02),
      };
    case "hitRate":
      return { target, min: 0, max: 100, reversion: 0.25, volatility: 0.15 };
    default:
      return { target, min: 0, max: 100, reversion: 0.2, volatility: 1 };
  }
}

const DECIMALS: Record<keyof ServiceMetrics, number> = {
  cpu: 1,
  memory: 1,
  latencyP95: 0,
  errorRate: 2,
  throughput: 0,
  hitRate: 1,
};

/** Walk one service's metrics toward its target for a single tick. */
export function tickServiceMetrics(
  current: ServiceMetrics,
  target: ServiceMetrics,
  rng: Rng,
): ServiceMetrics {
  const next: ServiceMetrics = { ...current };
  (Object.keys(current) as (keyof ServiceMetrics)[]).forEach((key) => {
    const cur = current[key];
    const tgt = target[key];
    if (cur === undefined || tgt === undefined) return;
    const walked = walkStep(cur, rng, metricSpec(key, tgt));
    next[key] = round(walked, DECIMALS[key]);
  });
  return next;
}

/** Snapshot the chartable fields of a metric bundle at time `t`. */
export function sampleFromMetrics(t: number, m: ServiceMetrics): MetricSample {
  return {
    t,
    cpu: m.cpu,
    memory: m.memory,
    latencyP95: m.latencyP95,
    errorRate: m.errorRate,
    throughput: m.throughput,
  };
}

/** Aggregate all services into a single cluster snapshot. */
export function aggregateCluster(
  t: number,
  services: Service[],
  criticalIncidents: number,
): ClusterMetrics {
  const n = services.length || 1;
  let cpu = 0;
  let memory = 0;
  let latency = 0;
  let errorRate = 0;
  let requestsPerMin = 0;
  let uptime = 0;

  for (const s of services) {
    cpu += s.metrics.cpu;
    memory += s.metrics.memory;
    latency += s.metrics.latencyP95;
    errorRate += s.metrics.errorRate;
    uptime += s.uptimePct;
    if (s.throughputUnit === "rpm") requestsPerMin += s.metrics.throughput;
  }

  return {
    t,
    cpu: round(cpu / n, 1),
    memory: round(memory / n, 1),
    latencyP95: round(latency / n, 0),
    errorRate: round(errorRate / n, 2),
    requestsPerMin: Math.round(requestsPerMin),
    uptimePct: round(uptime / n, 3),
    healthScore: computeHealthScore(services),
    servicesOnline: servicesOnline(services),
    servicesTotal: services.length,
    criticalIncidents,
  };
}

/** Append to a ring buffer, keeping at most `size` most-recent points. */
export function pushRing<T>(buffer: T[], item: T, size: number): T[] {
  const next = buffer.length >= size ? buffer.slice(buffer.length - size + 1) : buffer.slice();
  next.push(item);
  return next;
}

export { clamp };
