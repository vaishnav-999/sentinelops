import type {
  ExperimentRun,
  Incident,
  IncidentSeverity,
  IncidentStage,
  IncidentStatus,
  RemediationPolicy,
  RiskLevel,
  ServiceMetrics,
  StageRecord,
  StageStatus,
} from "@/lib/types";
import type { Tone } from "@/lib/tone";

/**
 * Pure read-models over the incident list. The page, the table and the detail
 * sheet all derive from these, so a status can never read one way in the table
 * and another in the drawer.
 */

/* ------------------------------------------------------------------ */
/* Labels & tones                                                      */
/* ------------------------------------------------------------------ */

export const INCIDENT_STATUSES: IncidentStatus[] = [
  "investigating",
  "detected",
  "auto_healing",
  "verifying",
  "resolved",
  "escalated",
];

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  detected: "Detected",
  auto_healing: "Auto-healing",
  verifying: "Verifying",
  resolved: "Resolved",
  escalated: "Escalated",
};

export const STATUS_TONE: Record<IncidentStatus, Tone> = {
  investigating: "ai",
  detected: "warn",
  auto_healing: "brand",
  verifying: "brand",
  resolved: "ok",
  escalated: "crit",
};

export const SEVERITIES: IncidentSeverity[] = ["critical", "warning", "info"];

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export const INCIDENT_SEVERITY_TONE: Record<IncidentSeverity, Tone> = {
  critical: "crit",
  warning: "warn",
  info: "muted",
};

/** An incident is open while it is neither resolved nor handed to an operator. */
export function isActive(incident: Incident): boolean {
  return incident.status !== "resolved" && incident.status !== "escalated";
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Display order of the incident pipeline (SPEC 11). */
export const STAGE_ORDER: IncidentStage[] = [
  "detected",
  "analyzed",
  "policy_check",
  "remediation",
  "verification",
  "resolved",
];

export const STAGE_LABEL: Record<IncidentStage, string> = {
  detected: "Detected",
  analyzed: "Analyzed",
  policy_check: "Policy check",
  remediation: "Remediation",
  verification: "Verification",
  resolved: "Resolved",
  escalated: "Escalated",
};

export const STAGE_STATUS_TONE: Record<StageStatus, Tone> = {
  pending: "muted",
  active: "brand",
  complete: "ok",
  skipped: "muted",
  failed: "crit",
};

export interface LifecycleRow extends StageRecord {
  /** ms since the previous reached stage, or null for the first / unreached. */
  durationMs: number | null;
}

/**
 * The pipeline as rows, in display order. A run that escalated ends on
 * ESCALATED instead of RESOLVED, so the sixth node swaps rather than both
 * appearing.
 */
export function lifecycleRows(incident: Incident): LifecycleRow[] {
  const escalated = incident.stages.some((s) => s.stage === "escalated");
  const order: IncidentStage[] = escalated
    ? [...STAGE_ORDER.slice(0, -1), "escalated"]
    : STAGE_ORDER;

  const byStage = new Map(incident.stages.map((s) => [s.stage, s]));
  let previousAt: number | null = null;

  return order.map((stage) => {
    const record = byStage.get(stage) ?? { stage, status: "pending" as StageStatus };
    const durationMs =
      record.at !== undefined && previousAt !== null ? record.at - previousAt : null;
    if (record.at !== undefined) previousAt = record.at;
    return { ...record, durationMs };
  });
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/**
 * Fallback fault signature to remediation policy, for incidents that never
 * recorded a `policyId`. The Diagnoser names a fault type; the policy table is
 * keyed on its own trigger vocabulary, so the mapping is explicit rather than
 * a string match that silently misses.
 */
const FAULT_POLICY: Record<string, string> = {
  memory_leak: "MEM-LEAK-01",
  memory_growth: "MEM-LEAK-01",
  service_crash: "CRASH-01",
  latency_spike: "LATENCY-01",
  cpu_saturation: "CPU-SAT-01",
  cache_saturation: "CACHE-SAT-01",
  db_failure: "DB-FAIL-01",
  unknown: "UNKNOWN-01",
};

/** The policy the run recorded, or the one its fault type maps to. */
export function policyFor(
  incident: Incident,
  policies: RemediationPolicy[],
): RemediationPolicy | undefined {
  const faultType = incident.diagnosis?.faultType;
  const id = incident.policyId ?? (faultType ? FAULT_POLICY[faultType] : undefined);
  return id ? policies.find((p) => p.id === id) : undefined;
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  safe: "Safe",
  review: "Review",
  restricted: "Restricted",
};

export const RISK_TONE: Record<RiskLevel, Tone> = {
  safe: "ok",
  review: "warn",
  restricted: "crit",
};

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/** Metrics compared side by side in the detail sheet (SPEC 11). */
export const COMPARE_METRICS = ["memory", "latencyP95", "errorRate"] as const;

export type CompareMetric = (typeof COMPARE_METRICS)[number];

export interface Observation {
  metric: CompareMetric;
  from: number;
  to: number;
}

/** The signal each fault signature is actually about. */
const FAULT_METRIC: Record<string, CompareMetric> = {
  memory_leak: "memory",
  memory_growth: "memory",
  cache_saturation: "memory",
  latency_spike: "latencyP95",
  service_crash: "errorRate",
  cpu_saturation: "errorRate",
};

/**
 * The one signal the "Observed" line should quote: the metric the diagnosed
 * fault is about, or — when nothing matched — whichever compared metric moved
 * furthest from its healthy baseline. Either way the sentence describes what
 * this run actually did, never a constant.
 */
export function observation(
  incident: Incident,
  baseline: ServiceMetrics | undefined,
): Observation | null {
  if (!incident.before || !baseline) return null;

  const read = (metric: CompareMetric): Observation | null => {
    const to = incident.before?.[metric];
    const from = baseline[metric];
    return to === undefined || from === undefined ? null : { metric, from, to };
  };

  const faultType = incident.diagnosis?.faultType;
  const preferred = faultType ? FAULT_METRIC[faultType] : undefined;
  if (preferred) {
    const hit = read(preferred);
    if (hit) return hit;
  }

  let best: Observation | null = null;
  let bestRatio = 0;
  for (const metric of COMPARE_METRICS) {
    const hit = read(metric);
    if (!hit || hit.from === 0) continue;
    const ratio = Math.abs(hit.to - hit.from) / hit.from;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = hit;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  policy: string | null;
  result: string;
  tone: Tone;
}

/** Every automated action leaves a row (SPEC 36). Derived from the stages. */
export function auditLog(
  incident: Incident,
  policy: RemediationPolicy | undefined,
): AuditEntry[] {
  const policyId = policy?.id ?? null;

  const copy: Record<
    IncidentStage,
    { action: string; policy: string | null; result: string; tone: Tone }
  > = {
    detected: {
      action: "anomaly_detected",
      policy: null,
      result: `${incident.id} opened`,
      tone: "warn",
    },
    analyzed: {
      action: "diagnose",
      policy: null,
      result: incident.diagnosis
        ? `${incident.diagnosis.faultType} · signature match ${Math.round(
            incident.diagnosis.match * 100,
          )}%`
        : "Matching fault signatures",
      tone: "ai",
    },
    policy_check: {
      action: "policy_check",
      policy: policyId,
      result: policy
        ? `${policy.action} · ${RISK_LABEL[policy.risk].toLowerCase()} · ${policy.mode}`
        : "No matching policy",
      tone: "brand",
    },
    remediation: {
      // The action the run actually took, not the policy's generic label.
      action: incident.action.trim().toLowerCase().replace(/\s+/g, "_"),
      policy: policyId,
      result: `Applied to ${incident.serviceId}`,
      tone: "brand",
    },
    verification: {
      action: "verify_health",
      policy: null,
      result: "Post-action health checks",
      tone: "ok",
    },
    resolved: {
      action: "close_incident",
      policy: null,
      result: incident.auto ? "Auto-healed" : "Closed",
      tone: "ok",
    },
    escalated: {
      action: "escalate",
      policy: policyId,
      result: "Awaiting operator approval",
      tone: "crit",
    },
  };

  return incident.stages
    .filter((s) => s.at !== undefined && s.status !== "pending")
    .slice()
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map((s) => {
      const base = copy[s.stage];
      return {
        id: `${incident.id}-${s.stage}`,
        at: s.at as number,
        actor: "sentinel-autoheal",
        action: base.action,
        policy: base.policy,
        result: s.status === "failed" ? (s.detail ?? base.result) : base.result,
        tone: s.status === "failed" ? ("crit" as Tone) : base.tone,
      };
    });
}

/* ------------------------------------------------------------------ */
/* Summary strip                                                       */
/* ------------------------------------------------------------------ */

export interface IncidentSummary {
  active: number;
  autoHealedToday: number;
  needsAttention: number;
  /** Mean detection latency across recorded chaos runs, seconds; null if none. */
  mttdSec: number | null;
  /** Mean recovery time across resolved incidents, seconds; null if none. */
  mttrSec: number | null;
  /** How many runs / incidents each mean is drawn from. */
  mttdSamples: number;
  mttrSamples: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return Math.round((total / values.length) * 10) / 10;
}

export function summarise(
  incidents: Incident[],
  runs: ExperimentRun[],
  now: number,
): IncidentSummary {
  const detectionLatencies = runs
    .filter((r) => r.mlDetectedAt !== null)
    .map((r) => ((r.mlDetectedAt as number) - r.injectedAt) / 1000);

  const recoveries = incidents
    .filter((i) => i.status === "resolved" && i.recoverySec !== undefined)
    .map((i) => i.recoverySec as number);

  return {
    active: incidents.filter(isActive).length,
    autoHealedToday: incidents.filter(
      (i) => i.auto && i.status === "resolved" && now - i.detectedAt <= DAY_MS,
    ).length,
    needsAttention: incidents.filter((i) => i.status === "escalated").length,
    mttdSec: mean(detectionLatencies),
    mttrSec: mean(recoveries),
    mttdSamples: detectionLatencies.length,
    mttrSamples: recoveries.length,
  };
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export interface IncidentFilters {
  severity: IncidentSeverity | "all";
  status: IncidentStatus | "all";
  service: string | "all";
  search: string;
}

export const EMPTY_FILTERS: IncidentFilters = {
  severity: "all",
  status: "all",
  service: "all",
  search: "",
};

/** Filtered, newest first. Search matches the incident id or its title. */
export function filterIncidents(
  incidents: Incident[],
  filters: IncidentFilters,
): Incident[] {
  const query = filters.search.trim().toLowerCase();
  return incidents
    .filter((i) => filters.severity === "all" || i.severity === filters.severity)
    .filter((i) => filters.status === "all" || i.status === filters.status)
    .filter((i) => filters.service === "all" || i.serviceId === filters.service)
    .filter(
      (i) =>
        query === "" ||
        i.id.toLowerCase().includes(query) ||
        i.title.toLowerCase().includes(query),
    )
    .slice()
    .sort((a, b) => b.detectedAt - a.detectedAt);
}
