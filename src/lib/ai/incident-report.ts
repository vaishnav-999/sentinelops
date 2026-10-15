import type {
  Incident,
  IncidentSeverity,
  IncidentStage,
  IncidentStatus,
  StageStatus,
} from "@/lib/types";

/**
 * Post-incident report (SPEC 37). The narrative is written from the recorded
 * incident only: detection, diagnosis and remediation were already decided by
 * deterministic policy, and the report never changes them.
 *
 * Pure module, shared by the route handler (server) and the sheet (client).
 */

export interface IncidentReport {
  summary: string;
  impact: string;
  rootCause: string;
  resolution: string;
  followUps: string[];
}

export interface IncidentReportResponse {
  report: IncidentReport;
  source: "gemini" | "fallback";
  model?: string;
  /** Why the deterministic report was used instead of Gemini. */
  reason?: string;
}

/** The subset of an incident sent to the model, length-capped. */
export interface ReportInput {
  id: string;
  title: string;
  serviceId: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  rootCause: string;
  action: string;
  detectedAt: number;
  resolvedAt?: number;
  recoverySec?: number;
  anomalyScore?: number;
  diagnosis?: { signature: string; match: number; faultType: string; summary?: string };
  policyId?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
  auto: boolean;
  outcomeLabel?: string;
  stages: { stage: IncidentStage; status: StageStatus; atSec?: number; detail?: string }[];
}

const SEVERITIES: IncidentSeverity[] = ["critical", "warning", "info"];
const STATUSES: IncidentStatus[] = [
  "investigating",
  "detected",
  "auto_healing",
  "verifying",
  "resolved",
  "escalated",
];
const STAGES: IncidentStage[] = [
  "detected",
  "analyzed",
  "policy_check",
  "remediation",
  "verification",
  "resolved",
  "escalated",
];
const STAGE_STATUSES: StageStatus[] = ["pending", "active", "complete", "skipped", "failed"];
const METRIC_KEYS = ["cpu", "memory", "latencyP95", "errorRate", "throughput"] as const;

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function metrics(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const key of METRIC_KEYS) {
    const n = num((v as Record<string, unknown>)[key]);
    if (n !== undefined) out[key] = Math.round(n * 100) / 100;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validates untrusted JSON into a ReportInput; null when unusable. */
export function toReportInput(raw: unknown): ReportInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 32);
  const title = str(r.title, 120);
  const serviceId = str(r.serviceId, 64);
  const severity = oneOf(r.severity, SEVERITIES);
  const status = oneOf(r.status, STATUSES);
  const detectedAt = num(r.detectedAt);
  if (!id || !title || !serviceId || !severity || !status || detectedAt === undefined) return null;

  const stages: ReportInput["stages"] = [];
  if (Array.isArray(r.stages)) {
    for (const s of r.stages.slice(0, 10)) {
      if (!s || typeof s !== "object") continue;
      const rec = s as Record<string, unknown>;
      const stage = oneOf(rec.stage, STAGES);
      const stageStatus = oneOf(rec.status, STAGE_STATUSES);
      if (!stage || !stageStatus) continue;
      const at = num(rec.at);
      stages.push({
        stage,
        status: stageStatus,
        atSec: at === undefined ? undefined : Math.round((at - detectedAt) / 100) / 10,
        detail: str(rec.detail, 240),
      });
    }
  }

  let diagnosis: ReportInput["diagnosis"];
  if (r.diagnosis && typeof r.diagnosis === "object") {
    const d = r.diagnosis as Record<string, unknown>;
    const signature = str(d.signature, 32);
    const match = num(d.match);
    const faultType = str(d.faultType, 48);
    if (signature && match !== undefined && faultType) {
      diagnosis = { signature, match, faultType, summary: str(d.summary, 400) };
    }
  }

  return {
    id,
    title,
    serviceId,
    severity,
    status,
    rootCause: str(r.rootCause, 400) ?? "",
    action: str(r.action, 80) ?? "",
    detectedAt,
    resolvedAt: num(r.resolvedAt),
    recoverySec: num(r.recoverySec),
    anomalyScore: num(r.anomalyScore),
    diagnosis,
    policyId: str(r.policyId, 32),
    before: metrics(r.before),
    after: metrics(r.after),
    auto: r.auto === true,
    outcomeLabel: str(r.outcomeLabel, 120),
    stages,
  };
}

export function isReportable(incident: Pick<Incident, "status">): boolean {
  return incident.status === "resolved" || incident.status === "escalated";
}

const METRIC_TEXT: Record<(typeof METRIC_KEYS)[number], [string, string]> = {
  cpu: ["CPU", "%"],
  memory: ["memory", "%"],
  latencyP95: ["p95 latency", " ms"],
  errorRate: ["error rate", "%"],
  throughput: ["throughput", ""],
};

function describeMetrics(m: Record<string, number> | undefined): string | null {
  if (!m) return null;
  const parts = METRIC_KEYS.filter((k) => m[k] !== undefined).map((k) => {
    const [label, unit] = METRIC_TEXT[k];
    return `${label} ${m[k]}${unit}`;
  });
  return parts.length ? parts.join(", ") : null;
}

const FOLLOW_UPS: Record<string, string[]> = {
  memory_leak: [
    "Profile the worker's heap to find the allocation that grows without release.",
    "Review the memory limit and restart guardrail for this worker.",
  ],
  cpu_saturation: [
    "Find the hot code path behind the CPU spike before relying on the extra replica.",
    "Decide whether the scaled-out replica should stay or be removed with Reset.",
  ],
  latency_spike: [
    "Trace slow requests to the dependency or query that added the latency.",
    "Check whether the restart cleared the cause or only the symptom.",
  ],
  service_crash: [
    "Read the container's exit code and last log lines to find why the process stopped.",
    "Confirm the service restarts cleanly without operator help.",
  ],
  cache_saturation: [
    "Review key TTLs and the maxmemory policy so the cache cannot fill again.",
    "Check which caller wrote the keys that filled the cache.",
  ],
};

/** Deterministic report built only from recorded facts. */
export function fallbackReport(input: ReportInput): IncidentReport {
  const resolved = input.status === "resolved";
  const outcome = resolved
    ? `auto-healed${input.recoverySec !== undefined ? ` in ${input.recoverySec} s` : ""}`
    : `escalated to an operator${input.outcomeLabel ? ` (${input.outcomeLabel})` : ""}`;
  const summary = `${input.id}: ${input.title} on ${input.serviceId}, ${input.severity} severity, ${outcome}.`;

  const before = describeMetrics(input.before);
  const after = describeMetrics(input.after);
  const impact = [
    before ? `At detection: ${before}.` : "No metric snapshot was recorded at detection.",
    after ? `After remediation: ${after}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const d = input.diagnosis;
  const rootCause = [
    input.anomalyScore !== undefined ? `Anomaly score ${input.anomalyScore.toFixed(2)}.` : null,
    d && d.signature !== "UNKNOWN"
      ? `Diagnoser signature ${d.signature} matched at ${Math.round(d.match * 100)}%. ${d.summary ?? ""}`.trim()
      : d?.summary || input.rootCause || "No fault signature was recorded.",
  ]
    .filter(Boolean)
    .join(" ");

  const steps = input.stages
    .filter((s) => s.status !== "pending")
    .map((s) => {
      const at = s.atSec !== undefined ? `+${s.atSec} s` : "";
      const detail = s.detail?.replace(/\.+$/, "");
      return `${s.stage.replace("_", " ")} ${s.status}${at ? ` at ${at}` : ""}${detail ? `: ${detail}` : ""}`;
    });
  const resolution = [
    input.action ? `Action: ${input.action}${input.policyId ? ` under policy ${input.policyId}` : ""}.` : null,
    steps.length ? `Timeline: ${steps.join("; ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const followUps = [
    ...(FOLLOW_UPS[d?.faultType ?? ""] ?? [
      "Have an operator review the telemetry; no known fault signature matched.",
      "If this pattern recurs, add a fault signature and a safe remediation policy for it.",
    ]),
    ...(resolved ? [] : ["Approve or reject the recommended action from the incident view."]),
  ];

  return { summary, impact, rootCause, resolution, followUps };
}

export const METRIC_UNITS = {
  cpu: "% of container CPU limit",
  memory: "% of container memory limit",
  latencyP95: "ms",
  errorRate: "% of requests",
  throughput: "requests or jobs per minute",
} as const;

export const REPORT_SYSTEM_PROMPT = [
  "You write concise post-incident reports for SentinelOps, a self-healing operations platform.",
  "Use only the facts in the incident JSON. Never invent metrics, times, causes or actions.",
  "Detection (Isolation Forest anomaly score and a static threshold rule), diagnosis (fault",
  "signature match) and remediation were decided by deterministic policy; describe them, do not",
  "second-guess or change them. Stage times are seconds after detection. Say 'signature match',",
  "never 'confidence'. Plain sentences, no markdown, no emojis. Each field at most 3 sentences;",
  "followUps are 2 to 4 short, concrete actions for a human operator.",
].join(" ");

export const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    impact: { type: "string" },
    rootCause: { type: "string" },
    resolution: { type: "string" },
    followUps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "impact", "rootCause", "resolution", "followUps"],
} as const;

/** Validates the model's JSON; null when it does not fit the schema. */
export function parseReport(text: string | undefined): IncidentReport | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const fields = ["summary", "impact", "rootCause", "resolution"] as const;
    if (!fields.every((f) => typeof v[f] === "string" && (v[f] as string).trim())) return null;
    if (!Array.isArray(v.followUps)) return null;
    const followUps = v.followUps
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, 4)
      .map((x) => x.slice(0, 300));
    return {
      summary: (v.summary as string).slice(0, 800),
      impact: (v.impact as string).slice(0, 800),
      rootCause: (v.rootCause as string).slice(0, 800),
      resolution: (v.resolution as string).slice(0, 800),
      followUps,
    };
  } catch {
    return null;
  }
}
