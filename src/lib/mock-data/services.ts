import type { Service, ServiceMetrics } from "@/lib/types";
import { HOUR, SEED_NOW } from "./constants";

/**
 * Six monitored services with the exact healthy values from SPEC §24.
 * `metrics` and `baseline` start identical; the noise walk mean-reverts toward
 * `baseline` and reset() restores it verbatim.
 *
 * Non-round numbers on purpose — this is meant to read like real telemetry.
 */

function seed(m: ServiceMetrics): ServiceMetrics {
  return { ...m };
}

export const SEED_SERVICES: Service[] = [
  {
    id: "api-gateway",
    name: "API Gateway",
    kind: "gateway",
    status: "healthy",
    containerId: "3f9a1c7e2b04",
    image: "sentinelops/api-gateway:2.4.1",
    port: 8080,
    uptimePct: 99.982,
    startedAt: SEED_NOW - 32 * HOUR,
    throughputUnit: "rpm",
    metrics: seed({
      cpu: 48,
      memory: 61,
      latencyP95: 142,
      errorRate: 0.3,
      throughput: 1842,
    }),
    baseline: seed({
      cpu: 48,
      memory: 61,
      latencyP95: 142,
      errorRate: 0.3,
      throughput: 1842,
    }),
  },
  {
    id: "auth-service",
    name: "Auth Service",
    kind: "service",
    status: "healthy",
    containerId: "a7e04c2f18d9",
    image: "sentinelops/auth-service:1.9.3",
    port: 8081,
    uptimePct: 99.995,
    startedAt: SEED_NOW - 54 * HOUR,
    throughputUnit: "rpm",
    metrics: seed({
      cpu: 31,
      memory: 54,
      latencyP95: 91,
      errorRate: 0.1,
      throughput: 982,
    }),
    baseline: seed({
      cpu: 31,
      memory: 54,
      latencyP95: 91,
      errorRate: 0.1,
      throughput: 982,
    }),
  },
  {
    id: "orders-service",
    name: "Orders Service",
    kind: "service",
    status: "healthy",
    containerId: "5c1b9d3e7a26",
    image: "sentinelops/orders-service:3.1.0",
    port: 8082,
    uptimePct: 99.94,
    startedAt: SEED_NOW - 26 * HOUR,
    throughputUnit: "rpm",
    metrics: seed({
      cpu: 57,
      memory: 66,
      latencyP95: 176,
      errorRate: 0.6,
      throughput: 711,
    }),
    baseline: seed({
      cpu: 57,
      memory: 66,
      latencyP95: 176,
      errorRate: 0.6,
      throughput: 711,
    }),
  },
  {
    id: "payment-worker",
    name: "Payment Worker",
    kind: "worker",
    status: "healthy",
    containerId: "9d40b7c1e5a8",
    image: "sentinelops/payment-worker:2.2.7",
    port: 9110,
    uptimePct: 99.97,
    startedAt: SEED_NOW - 18 * HOUR,
    throughputUnit: "jobs/min",
    metrics: seed({
      cpu: 42,
      memory: 59,
      latencyP95: 188,
      errorRate: 0.4,
      throughput: 486,
    }),
    baseline: seed({
      cpu: 42,
      memory: 59,
      latencyP95: 188,
      errorRate: 0.4,
      throughput: 486,
    }),
  },
  {
    id: "notification-worker",
    name: "Notification Worker",
    kind: "worker",
    status: "healthy",
    containerId: "47a1e9c02f6b",
    image: "sentinelops/notification-worker:1.5.2",
    port: 9120,
    uptimePct: 99.99,
    startedAt: SEED_NOW - 41 * HOUR,
    throughputUnit: "jobs/min",
    metrics: seed({
      cpu: 24,
      memory: 41,
      latencyP95: 122,
      errorRate: 0.2,
      throughput: 213,
    }),
    baseline: seed({
      cpu: 24,
      memory: 41,
      latencyP95: 122,
      errorRate: 0.2,
      throughput: 213,
    }),
  },
  {
    id: "redis-cache",
    name: "Redis Cache",
    kind: "cache",
    status: "healthy",
    containerId: "b6c3f0a75e19",
    image: "redis:7.2-alpine",
    port: 6379,
    uptimePct: 99.999,
    startedAt: SEED_NOW - 63 * HOUR,
    throughputUnit: "rpm",
    metrics: seed({
      cpu: 18,
      memory: 63,
      latencyP95: 7,
      errorRate: 0.02,
      throughput: 8460,
      hitRate: 96.8,
    }),
    baseline: seed({
      cpu: 18,
      memory: 63,
      latencyP95: 7,
      errorRate: 0.02,
      throughput: 8460,
      hitRate: 96.8,
    }),
  },
];

/** Deep clone of the seed services (fresh objects for store / reset). */
export function cloneSeedServices(): Service[] {
  return SEED_SERVICES.map((s) => ({
    ...s,
    metrics: { ...s.metrics },
    baseline: { ...s.baseline },
  }));
}
