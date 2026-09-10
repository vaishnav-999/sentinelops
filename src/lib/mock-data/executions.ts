import type { RemediationExecution, TerminalLine, TerminalLevel } from "@/lib/types";
import { HOUR, MINUTE, SEED_NOW } from "./constants";

/**
 * Six historical remediation executions (EXE-2201..EXE-2206) — the audit trail
 * behind the "Recent executions" panel on /auto-heal.
 *
 * Five succeeded and one escalated, so the success rate the page shows is a
 * real quotient over these records rather than a figure typed into the UI. The
 * three most recent line up with the seeded incidents (INC-1039..INC-1041).
 *
 * All timestamps hang off the fixed `SEED_NOW` anchor so the server and the
 * client render the same HTML; the engine rebases them onto the real clock
 * once it starts, exactly as it does for the seeded incidents.
 */

/** Build the terminal transcript for one seeded execution. */
function transcript(
  id: string,
  startedAt: number,
  steps: [offsetSec: number, text: string, level: TerminalLevel][],
): TerminalLine[] {
  return steps.map(([offset, text, level], i) => ({
    id: `${id}-l${i + 1}`,
    t: startedAt + Math.round(offset * 1000),
    text,
    level,
  }));
}

interface SeedSpec {
  id: string;
  incidentId: string;
  policyId: string;
  serviceId: string;
  action: string;
  startedAt: number;
  durationSec: number;
  outcome: RemediationExecution["outcome"];
  steps: [number, string, TerminalLevel][];
}

const SPECS: SeedSpec[] = [
  {
    id: "EXE-2206",
    incidentId: "INC-1041",
    policyId: "CPU-SAT-01",
    serviceId: "api-gateway",
    action: "scale_replicas",
    startedAt: SEED_NOW - 3 * HOUR,
    durationSec: 42,
    outcome: "success",
    steps: [
      [0, "anomaly detected", "warn"],
      [2.4, "classification: latency_spike", "info"],
      [2.6, "signature match: 0.82", "info"],
      [4.1, "evaluating remediation policy CPU-SAT-01", "command"],
      [5.8, "action approved: scale_replicas", "command"],
      [6.0, "executing...", "info"],
      [21.3, "api-gateway scaled to 3 replicas", "success"],
      [36.7, "health verification passed", "success"],
      [42.0, "INCIDENT RESOLVED", "success"],
    ],
  },
  {
    id: "EXE-2205",
    incidentId: "INC-1040",
    policyId: "CACHE-SAT-01",
    serviceId: "redis-cache",
    action: "clear_cache",
    startedAt: SEED_NOW - 6 * HOUR,
    durationSec: 11,
    outcome: "success",
    steps: [
      [0, "anomaly detected", "warn"],
      [1.2, "classification: cache_saturation", "info"],
      [1.4, "signature match: 0.88", "info"],
      [2.1, "evaluating remediation policy CACHE-SAT-01", "command"],
      [3.0, "action approved: clear_cache", "command"],
      [3.2, "executing...", "info"],
      [6.4, "redis-cache flushed — 1.4 GB reclaimed", "success"],
      [9.6, "health verification passed", "success"],
      [11.0, "INCIDENT RESOLVED", "success"],
    ],
  },
  {
    id: "EXE-2204",
    incidentId: "INC-1039",
    policyId: "CRASH-01",
    serviceId: "notification-worker",
    action: "restart_container",
    startedAt: SEED_NOW - 22 * HOUR,
    durationSec: 14,
    outcome: "success",
    steps: [
      [0, "anomaly detected", "warn"],
      [1.6, "classification: service_crash", "info"],
      [1.8, "signature match: 0.94", "info"],
      [2.9, "evaluating remediation policy CRASH-01", "command"],
      [3.7, "action approved: restart_container", "command"],
      [3.9, "executing...", "info"],
      [8.2, "notification-worker container restarted", "success"],
      [12.4, "health verification passed", "success"],
      [14.0, "INCIDENT RESOLVED", "success"],
    ],
  },
  {
    id: "EXE-2203",
    incidentId: "INC-1038",
    policyId: "UNKNOWN-01",
    serviceId: "orders-service",
    action: "escalate",
    startedAt: SEED_NOW - 31 * HOUR,
    durationSec: 9,
    outcome: "escalated",
    steps: [
      [0, "anomaly detected", "warn"],
      [3.2, "classification: unknown", "warn"],
      [3.4, "signature match: 0.38", "warn"],
      [5.1, "evaluating remediation policy", "command"],
      [7.6, "no matching policy — manual approval required", "error"],
      [9.0, "ESCALATED — awaiting operator approval", "error"],
    ],
  },
  {
    id: "EXE-2202",
    incidentId: "INC-1037",
    policyId: "MEM-LEAK-01",
    serviceId: "payment-worker",
    action: "restart_worker",
    startedAt: SEED_NOW - 39 * HOUR,
    durationSec: 19,
    outcome: "success",
    steps: [
      [0, "anomaly detected", "warn"],
      [2.7, "classification: memory_leak", "info"],
      [2.9, "signature match: 0.93", "info"],
      [4.3, "evaluating remediation policy MEM-LEAK-01", "command"],
      [5.6, "action approved: restart_worker", "command"],
      [5.8, "executing...", "info"],
      [11.2, "payment-worker restarted", "success"],
      [17.1, "health verification passed", "success"],
      [19.0, "INCIDENT RESOLVED", "success"],
    ],
  },
  {
    id: "EXE-2201",
    incidentId: "INC-1036",
    policyId: "LATENCY-01",
    serviceId: "orders-service",
    action: "restart_container",
    startedAt: SEED_NOW - 46 * HOUR - 20 * MINUTE,
    durationSec: 23,
    outcome: "success",
    steps: [
      [0, "anomaly detected", "warn"],
      [2.2, "classification: latency_spike", "info"],
      [2.4, "signature match: 0.87", "info"],
      [3.8, "evaluating remediation policy LATENCY-01", "command"],
      [5.2, "action approved: restart_container", "command"],
      [5.4, "executing...", "info"],
      [13.6, "orders-service container restarted", "success"],
      [20.8, "health verification passed", "success"],
      [23.0, "INCIDENT RESOLVED", "success"],
    ],
  },
];

export const SEED_EXECUTIONS: RemediationExecution[] = SPECS.map((spec) => ({
  id: spec.id,
  incidentId: spec.incidentId,
  policyId: spec.policyId,
  serviceId: spec.serviceId,
  action: spec.action,
  startedAt: spec.startedAt,
  completedAt: spec.startedAt + spec.durationSec * 1000,
  outcome: spec.outcome,
  dryRun: false,
  lines: transcript(spec.id, spec.startedAt, spec.steps),
}));

export function cloneSeedExecutions(): RemediationExecution[] {
  return SEED_EXECUTIONS.map((e) => ({
    ...e,
    lines: e.lines.map((l) => ({ ...l })),
  }));
}

/** The newest seeded execution — the one /auto-heal opens on. */
export const SEED_SELECTED_EXECUTION_ID = SEED_EXECUTIONS[0].id;
