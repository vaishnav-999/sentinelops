import type {
  Anomaly,
  ClusterMetrics,
  DetectorResult,
  FeatureContribution,
  Incident,
  LogEntry,
  LogLevel,
  MetricSample,
  RemediationExecution,
  RemediationPolicy,
  ScenarioId,
  Service,
} from "@/lib/types";

/**
 * SentinelClient — the transport-agnostic contract between the UI and the data
 * source. There is exactly one method per future backend endpoint (SPEC §32),
 * so the mock (simulation-backed) and http (FastAPI-backed) implementations
 * stay interchangeable behind `api`.
 */

/** GET /api/services/:id/metrics */
export interface ServiceMetricsResult {
  service: Service | null;
  /** Ring-buffer history for charts. */
  samples: MetricSample[];
}

/** GET /api/logs query. */
export interface LogsQuery {
  level?: LogLevel;
  service?: string;
  search?: string;
  limit?: number;
}

/** POST /api/remediation/execute body. */
export interface RemediationExecuteInput {
  policyId: string;
  serviceId: string;
  incidentId?: string;
  dryRun?: boolean;
}

/** POST /api/chaos/inject body. */
export interface ChaosInjectInput {
  scenario: ScenarioId;
}

export interface ChaosInjectResult {
  accepted: boolean;
  runId?: string;
}

/** GET /api/ml/status */
export interface MlStatus {
  model: string;
  status: "active" | "training" | "idle";
  baselineWindowHours: number;
  anomalyScore: number;
  detectors: DetectorResult[];
  contributions: FeatureContribution[];
  /** Research metrics are never fabricated — null until real evaluation. */
  research: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    falsePositiveRate: number | null;
    mttdImprovement: number | null;
    mttrImprovement: number | null;
  };
}

export interface SentinelClient {
  /** GET /api/system/health */
  getSystemHealth(): Promise<ClusterMetrics>;
  /** GET /api/services */
  getServices(): Promise<Service[]>;
  /** GET /api/services/:id/metrics */
  getServiceMetrics(id: string): Promise<ServiceMetricsResult>;
  /** GET /api/incidents */
  getIncidents(): Promise<Incident[]>;
  /** GET /api/incidents/:id */
  getIncident(id: string): Promise<Incident | null>;
  /** GET /api/logs */
  getLogs(query?: LogsQuery): Promise<LogEntry[]>;
  /** GET /api/anomalies */
  getAnomalies(): Promise<Anomaly[]>;
  /** GET /api/remediation/policies */
  getRemediationPolicies(): Promise<RemediationPolicy[]>;
  /** POST /api/remediation/execute */
  executeRemediation(input: RemediationExecuteInput): Promise<RemediationExecution>;
  /** POST /api/chaos/inject */
  injectChaos(input: ChaosInjectInput): Promise<ChaosInjectResult>;
  /** GET /api/ml/status */
  getMlStatus(): Promise<MlStatus>;
}
