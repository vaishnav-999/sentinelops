import type { ScenarioId } from "@/lib/types";

/**
 * The Chaos Lab catalogue (SPEC §13). Card copy only — the choreography lives
 * in src/lib/simulation/scenarios. Every card maps to a registered scenario,
 * so there are no dead buttons.
 */

export type FaultSeverity = "Medium" | "High" | "Critical";

export interface ChaosFault {
  scenarioId: ScenarioId;
  name: string;
  description: string;
  /** Service the fault is injected into. */
  target: string;
  severity: FaultSeverity;
  /** What the platform is expected to do about it. */
  expected: "Auto-heal" | "Escalate";
  /** Button copy, e.g. "Inject Memory Leak". */
  action: string;
  /** Approximate run length in seconds, including the 3 s countdown. */
  durationSec: number;
}

export const CHAOS_FAULTS: ChaosFault[] = [
  {
    scenarioId: "memory-leak",
    name: "Memory Leak",
    description: "Simulate progressive memory consumption.",
    target: "payment-worker",
    severity: "High",
    expected: "Auto-heal",
    action: "Inject Memory Leak",
    durationSec: 39,
  },
  {
    scenarioId: "unknown-anomaly",
    name: "Unknown Anomaly",
    description: "Weak mixed signals with no matching fault signature.",
    target: "orders-service",
    severity: "High",
    expected: "Escalate",
    action: "Inject Unknown Anomaly",
    durationSec: 36,
  },
  {
    scenarioId: "cpu-spike",
    name: "CPU Spike",
    description: "Simulate sustained CPU saturation.",
    target: "api-gateway",
    severity: "Medium",
    expected: "Auto-heal",
    action: "Inject CPU Spike",
    durationSec: 29,
  },
  {
    scenarioId: "service-crash",
    name: "Service Crash",
    description: "Terminate payment-worker.",
    target: "payment-worker",
    severity: "Critical",
    expected: "Auto-heal",
    action: "Crash Service",
    durationSec: 29,
  },
  {
    scenarioId: "latency-injection",
    name: "Latency Injection",
    description: "Add artificial response delay.",
    target: "orders-service",
    severity: "Medium",
    expected: "Auto-heal",
    action: "Inject Latency",
    durationSec: 29,
  },
  {
    scenarioId: "cache-saturation",
    name: "Cache Saturation",
    description: "Simulate Redis memory pressure.",
    target: "redis-cache",
    severity: "Medium",
    expected: "Auto-heal",
    action: "Saturate Cache",
    durationSec: 29,
  },
];
