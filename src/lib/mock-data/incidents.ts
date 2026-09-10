import type { Incident, StageRecord } from "@/lib/types";
import { HOUR, SEED_NOW } from "./constants";

/**
 * Three resolved historical incidents (INC-1039..INC-1041) with full stage
 * timelines. The next id the engine mints for the live memory-leak demo is
 * therefore INC-1042 (matches the SPEC walkthrough).
 */

/** Build a fully-completed six-stage timeline from a detection time. */
function resolvedStages(detectedAt: number, recoverySec: number): StageRecord[] {
  const span = recoverySec * 1000;
  return [
    { stage: "detected", status: "complete", at: detectedAt },
    {
      stage: "analyzed",
      status: "complete",
      at: detectedAt + Math.round(span * 0.15),
      detail: "Isolation Forest scored anomaly; diagnoser matched signature.",
    },
    {
      stage: "policy_check",
      status: "complete",
      at: detectedAt + Math.round(span * 0.28),
      detail: "Safe automatic policy selected.",
    },
    {
      stage: "remediation",
      status: "complete",
      at: detectedAt + Math.round(span * 0.4),
    },
    {
      stage: "verification",
      status: "complete",
      at: detectedAt + Math.round(span * 0.82),
      detail: "Post-action health checks passed.",
    },
    { stage: "resolved", status: "complete", at: detectedAt + span },
  ];
}

const INC_1041_AT = SEED_NOW - 3 * HOUR;
const INC_1040_AT = SEED_NOW - 6 * HOUR;
const INC_1039_AT = SEED_NOW - 22 * HOUR;

export const SEED_INCIDENTS: Incident[] = [
  {
    id: "INC-1041",
    title: "Latency spike",
    serviceId: "api-gateway",
    severity: "warning",
    status: "resolved",
    rootCause: "Traffic burst",
    action: "Scaled replicas",
    policyId: "CPU-SAT-01",
    detectedAt: INC_1041_AT,
    resolvedAt: INC_1041_AT + 42_000,
    recoverySec: 42,
    stages: resolvedStages(INC_1041_AT, 42),
    anomalyScore: 0.71,
    diagnosis: {
      signature: "LATENCY-BURST",
      match: 0.82,
      faultType: "latency_spike",
      summary: "p95 latency rose sharply under a short traffic burst.",
    },
    before: { latencyP95: 612, cpu: 79, errorRate: 2.1 },
    after: { latencyP95: 148, cpu: 51, errorRate: 0.3 },
    auto: true,
  },
  {
    id: "INC-1040",
    title: "Cache saturation",
    serviceId: "redis-cache",
    severity: "warning",
    status: "resolved",
    rootCause: "Memory pressure",
    action: "Clear cache",
    policyId: "CACHE-SAT-01",
    detectedAt: INC_1040_AT,
    resolvedAt: INC_1040_AT + 11_000,
    recoverySec: 11,
    stages: resolvedStages(INC_1040_AT, 11),
    anomalyScore: 0.66,
    diagnosis: {
      signature: "CACHE-SAT",
      match: 0.88,
      faultType: "cache_saturation",
      summary: "Hit rate fell as memory pressure grew; eviction restored it.",
    },
    before: { memory: 92, hitRate: 71.4, latencyP95: 34 },
    after: { memory: 64, hitRate: 96.5, latencyP95: 7 },
    auto: true,
  },
  {
    id: "INC-1039",
    title: "Service crash",
    serviceId: "notification-worker",
    severity: "critical",
    status: "resolved",
    rootCause: "OOM kill",
    action: "Restart container",
    policyId: "CRASH-01",
    detectedAt: INC_1039_AT,
    resolvedAt: INC_1039_AT + 14_000,
    recoverySec: 14,
    stages: resolvedStages(INC_1039_AT, 14),
    anomalyScore: 0.92,
    diagnosis: {
      signature: "CRASH",
      match: 0.94,
      faultType: "service_crash",
      summary: "Container exceeded its memory limit and was killed by the OOM reaper.",
    },
    before: { memory: 99, errorRate: 58.3, latencyP95: 1380 },
    after: { memory: 41, errorRate: 0.3, latencyP95: 164 },
    auto: true,
  },
];

/** The next incident id the engine assigns to the live demo. */
export const NEXT_INCIDENT_SEQ = 1042;

export function cloneSeedIncidents(): Incident[] {
  return SEED_INCIDENTS.map((i) => ({
    ...i,
    stages: i.stages.map((s) => ({ ...s })),
    diagnosis: i.diagnosis ? { ...i.diagnosis } : undefined,
    before: i.before ? { ...i.before } : undefined,
    after: i.after ? { ...i.after } : undefined,
  }));
}
