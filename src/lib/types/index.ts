/**
 * SentinelOps domain types.
 *
 * These are the shared contracts between the simulation engine, the Zustand
 * store, the API clients and (eventually) a real FastAPI backend. Keep them
 * transport-agnostic: plain serialisable data, epoch-millisecond timestamps,
 * no class instances.
 */

/* ------------------------------------------------------------------ */
/* Environment / global selectors                                      */
/* ------------------------------------------------------------------ */

export type EnvironmentId = "production" | "staging" | "development";

export type TimeRange = "15m" | "1h" | "6h" | "24h" | "7d";

export type ConnectionStatus = "ok" | "lost";

/* ------------------------------------------------------------------ */
/* Services & metrics                                                  */
/* ------------------------------------------------------------------ */

export type ServiceStatus = "healthy" | "degraded" | "critical" | "recovering";

export type ServiceKind = "gateway" | "service" | "worker" | "cache";

/** How a service reports work done: HTTP requests vs background jobs. */
export type ThroughputUnit = "rpm" | "jobs/min";

/** The live metric bundle for a single service. */
export interface ServiceMetrics {
  /** CPU utilisation, percent (0–100). */
  cpu: number;
  /** Memory utilisation, percent (0–100). */
  memory: number;
  /** p95 response/processing latency, milliseconds. */
  latencyP95: number;
  /** Error rate, percent (0–100). */
  errorRate: number;
  /** Requests/min or jobs/min depending on `Service.throughputUnit`. */
  throughput: number;
  /** Cache hit rate, percent (0–100). Present on cache services only. */
  hitRate?: number;
}

export interface Service {
  id: string;
  name: string;
  kind: ServiceKind;
  status: ServiceStatus;
  /** 12-char container id this service currently runs in. */
  containerId: string;
  image: string;
  port: number;
  uptimePct: number;
  /** Epoch ms the current container instance started (drives uptime display). */
  startedAt: number;
  throughputUnit: ThroughputUnit;
  /** Current live metrics. */
  metrics: ServiceMetrics;
  /**
   * Healthy seed values. The noise walk mean-reverts toward these and
   * `reset()` restores them exactly, so the demo always returns to baseline.
   */
  baseline: ServiceMetrics;
}

/** A single time-series datapoint for charts / ring buffers. */
export interface MetricSample {
  /** Epoch ms. */
  t: number;
  cpu: number;
  memory: number;
  latencyP95: number;
  errorRate: number;
  throughput: number;
}

/** Aggregate view across the whole cluster at one instant. */
export interface ClusterMetrics {
  t: number;
  cpu: number;
  memory: number;
  latencyP95: number;
  errorRate: number;
  /** Total requests/min across HTTP-facing services. */
  requestsPerMin: number;
  uptimePct: number;
  /** Weighted health score, 0–100 (see simulation/health.ts). */
  healthScore: number;
  servicesOnline: number;
  servicesTotal: number;
  criticalIncidents: number;
}

/* ------------------------------------------------------------------ */
/* Containers & infrastructure topology                                */
/* ------------------------------------------------------------------ */

export type ContainerStatus =
  | "running"
  | "restarting"
  | "stopped"
  | "unhealthy";

export interface Container {
  /** 12-char hex short id, Docker-style. */
  id: string;
  name: string;
  /** repository/name:tag */
  image: string;
  serviceId?: string;
  status: ContainerStatus;
  /** CPU utilisation, percent. */
  cpu: number;
  /** Memory utilisation, percent. */
  memory: number;
  createdAt: number;
}

export type InfraNodeKind =
  | "internet"
  | "gateway"
  | "service"
  | "worker"
  | "cache"
  | "database";

export interface InfraNode {
  id: string;
  label: string;
  kind: InfraNodeKind;
  /** Linked service, when the node represents a monitored service. */
  serviceId?: string;
  status?: ServiceStatus;
  meta?: {
    port?: number;
    containerId?: string;
    image?: string;
  };
}

export type InfraEdgeKind = "request" | "data" | "cache";

export interface InfraEdge {
  id: string;
  from: string;
  to: string;
  kind?: InfraEdgeKind;
}

/* ------------------------------------------------------------------ */
/* Detection & diagnosis (two-stage pipeline, SPEC §36)                */
/* ------------------------------------------------------------------ */

export type AnomalyBaseline = "normal" | "elevated" | "abnormal";

/** A single signal's contribution to the anomaly score (ML Insights). */
export interface FeatureContribution {
  feature: string;
  /** Share of the score, percent (0–100). */
  weight: number;
}

/** Stage 1 output: Isolation Forest anomaly score + context. */
export interface Anomaly {
  /** Anomaly score, 0–1. */
  score: number;
  baseline: AnomalyBaseline;
  serviceId?: string;
  detectedAt?: number;
  note?: string;
  contributions?: FeatureContribution[];
}

export type DetectorKind = "threshold" | "ml";

/**
 * One detector's verdict. Chaos runs show a static threshold rule and the
 * ML detector side by side, each with its own `firedAt` (SPEC §36).
 */
export interface DetectorResult {
  kind: DetectorKind;
  /** Human label, e.g. "Static threshold rule" / "Isolation Forest". */
  label: string;
  fired: boolean;
  /** Epoch ms the detector first fired, or null while quiet. */
  firedAt: number | null;
  /** Threshold value breached, or the anomaly score, depending on kind. */
  value?: number;
  detail?: string;
}

/**
 * Stage 2 output: the Diagnoser matches feature deviation against known
 * fault signatures. This is a "Signature match", never a "confidence".
 */
export interface Diagnosis {
  /** Fault signature id, e.g. "MEM-LEAK". */
  signature: string;
  /** Signature match strength, 0–1. */
  match: number;
  /** Machine fault label, e.g. "memory_growth". */
  faultType: string;
  summary?: string;
}

/* ------------------------------------------------------------------ */
/* Remediation                                                         */
/* ------------------------------------------------------------------ */

export type RiskLevel = "safe" | "review" | "restricted";

export type RemediationMode = "automatic" | "manual";

export type RemediationActionKind =
  | "restart_container"
  | "restart_worker"
  | "clear_cache"
  | "scale_replicas"
  | "alert_operator"
  | "escalate";

export interface RemediationPolicy {
  /** Stable id, e.g. "MEM-LEAK-01". */
  id: string;
  name: string;
  /** Fault signature / condition this policy responds to. */
  trigger: string;
  /** Human-readable action, e.g. "Restart Worker". */
  action: string;
  actionKind: RemediationActionKind;
  risk: RiskLevel;
  mode: RemediationMode;
  description?: string;
}

export type RemediationOutcome =
  | "in_progress"
  | "success"
  | "failed"
  | "escalated";

export interface RemediationExecution {
  id: string;
  incidentId: string;
  policyId: string;
  serviceId: string;
  action: string;
  startedAt: number;
  completedAt?: number;
  outcome: RemediationOutcome;
  /** When true the action was simulated only (no state change committed). */
  dryRun: boolean;
  lines: TerminalLine[];
}

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

export type IncidentSeverity = "critical" | "warning" | "info";

export type IncidentStatus =
  | "investigating"
  | "detected"
  | "auto_healing"
  | "verifying"
  | "resolved"
  | "escalated";

/** Ordered lifecycle stages shown in the incident-detail pipeline (§11). */
export type IncidentStage =
  | "detected"
  | "analyzed"
  | "policy_check"
  | "remediation"
  | "verification"
  | "resolved"
  | "escalated";

export type StageStatus =
  | "pending"
  | "active"
  | "complete"
  | "skipped"
  | "failed";

export interface StageRecord {
  stage: IncidentStage;
  status: StageStatus;
  /** Epoch ms the stage was entered / completed, if reached. */
  at?: number;
  detail?: string;
}

export interface Incident {
  /** e.g. "INC-1042". */
  id: string;
  title: string;
  serviceId: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  rootCause: string;
  /** Remediation action taken/recommended, e.g. "Restart worker". */
  action: string;
  detectedAt: number;
  resolvedAt?: number;
  /** Recovery time in seconds (detected → resolved). */
  recoverySec?: number;
  stages: StageRecord[];
  anomalyScore?: number;
  diagnosis?: Diagnosis;
  before?: Partial<ServiceMetrics>;
  after?: Partial<ServiceMetrics>;
  /** True when resolved autonomously, false when escalated to an operator. */
  auto: boolean;
  scenarioId?: ScenarioId;
}

/* ------------------------------------------------------------------ */
/* Events, terminal, logs                                              */
/* ------------------------------------------------------------------ */

export type EventKind =
  | "telemetry"
  | "health"
  | "anomaly"
  | "incident"
  | "remediation"
  | "verification"
  | "info";

export type Severity = "info" | "ok" | "warn" | "crit" | "ai";

export interface SystemEvent {
  id: string;
  t: number;
  kind: EventKind;
  message: string;
  serviceId?: string;
  severity: Severity;
}

export type TerminalLevel =
  | "info"
  | "warn"
  | "error"
  | "success"
  | "command";

export interface TerminalLine {
  id: string;
  t: number;
  text: string;
  level: TerminalLevel;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  id: string;
  t: number;
  level: LogLevel;
  /** Emitting service id/name. */
  service: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Scenarios & experiments                                             */
/* ------------------------------------------------------------------ */

export type ScenarioId =
  | "memory-leak"
  | "unknown-anomaly"
  | "cpu-spike"
  | "service-crash"
  | "latency-injection"
  | "cache-saturation";

/** Phase of a running scenario, mirrored into the store for live UI. */
export type ScenarioPhase =
  | "idle"
  | "injecting"
  | "detected"
  | "diagnosing"
  | "policy_check"
  | "remediating"
  | "verifying"
  | "resolved"
  | "escalated";

/** Sentinel Status Island state (SPEC §19). */
export type IslandState =
  | "operational"
  | "anomaly"
  | "diagnosing"
  | "healing"
  | "verifying"
  | "recovered"
  | "escalated";

export type ExperimentOutcome =
  | "running"
  | "auto_healed"
  | "escalated"
  | "cancelled"
  | "failed";

/**
 * A recorded chaos experiment. Shaped for a future `POST /api/experiments`.
 * Detection times are labelled Simulated in the UI (SPEC §36).
 */
export interface ExperimentRun {
  id: string;
  scenarioId: ScenarioId;
  faultType: string;
  target: string;
  injectedAt: number;
  thresholdDetectedAt: number | null;
  mlDetectedAt: number | null;
  remediatedAt: number | null;
  outcome: ExperimentOutcome;
}

/* ------------------------------------------------------------------ */
/* Chaos Lab run console                                               */
/* ------------------------------------------------------------------ */

/**
 * The phase stepper shown in the Chaos Lab run console. One id per
 * `ScenarioPhase` that a run can actually reach, in display order. A run ends
 * on either `resolved` or `escalated`, never both.
 */
export type RunStepId =
  | "injected"
  | "detected"
  | "analyzing"
  | "policy_check"
  | "remediating"
  | "verifying"
  | "resolved"
  | "escalated";

export interface RunStepRecord {
  id: RunStepId;
  /** Engine clock the step was entered, or null while still pending. */
  at: number | null;
}

export type ChaosRunOutcome =
  | "running"
  | "auto_healed"
  | "escalated"
  | "cancelled";

/**
 * Live state of the Chaos Lab run console. Owned by the engine, mirrored into
 * the store so the console keeps rendering after the run finishes (and so a
 * run started on /chaos-lab stays visible when you navigate away and back).
 */
export interface ChaosRunState {
  /** Matches the ExperimentRun id, so the table and the console agree. */
  runId: string;
  scenarioId: ScenarioId;
  title: string;
  target: string;
  /** The metric the console charts, with its threshold line. */
  metric: "cpu" | "memory" | "latencyP95" | "errorRate";
  threshold: number;
  thresholdLabel: string;
  /** Engine clock the run was requested — the start of the 3-2-1 countdown. */
  requestedAt: number;
  /** Engine clock the fault was injected; null while still counting down. */
  injectedAt: number | null;
  /** 3 → 2 → 1 during the countdown, null once injected. */
  countdown: number | null;
  steps: RunStepRecord[];
  current: RunStepId | null;
  incidentId: string | null;
  diagnosisNote: string | null;
  policyNote: string | null;
  healthChecks: string[];
  /** Remediation action taken, e.g. "restart_container". */
  action: string | null;
  outcome: ChaosRunOutcome;
  finishedAt: number | null;
  /** Seconds after injection the anomaly detector fired. */
  mlDetectedSec: number | null;
  /** Seconds after injection the static threshold rule fired. */
  thresholdDetectedSec: number | null;
  /** Detection → resolution, seconds. */
  recoverySec: number | null;
}

/* ------------------------------------------------------------------ */
/* Settings & guardrails                                               */
/* ------------------------------------------------------------------ */

export interface SentinelSettings {
  /** Master switch for autonomous remediation. */
  autoRemediation: boolean;
  /** When true, remediation actions are simulated but never "committed". */
  dryRun: boolean;
  /** Max auto-restart actions allowed per service inside the cooldown window. */
  restartLimit: number;
  /** Guardrail window / cooldown, seconds (SPEC §36: 30 min = 1800). */
  cooldownSec: number;
}

/**
 * Guardrail bookkeeping: epoch-ms timestamps of automated actions per service,
 * used to enforce `restartLimit` within `cooldownSec`.
 */
export interface GuardrailState {
  actionsByService: Record<string, number[]>;
}
