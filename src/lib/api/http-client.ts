import type {
  Anomaly,
  ClusterMetrics,
  Incident,
  LogEntry,
  RemediationExecution,
  RemediationPolicy,
  Service,
} from "@/lib/types";
import type {
  ChaosInjectInput,
  ChaosInjectResult,
  LogsQuery,
  MlStatus,
  RemediationExecuteInput,
  SentinelClient,
  ServiceMetricsResult,
} from "./sentinel-client";

import { apiFetch } from "./fetch";

/**
 * HTTP client for the FastAPI backend (backend/app/main.py). Selected when
 * NEXT_PUBLIC_DATA_SOURCE === "http". Live telemetry does not poll these
 * endpoints — it streams over the /ws WebSocket (src/lib/live). These calls
 * serve commands and one-off reads, with the same return types as
 * MockSentinelClient.
 */

function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) query.set(k, v);
  }
  const qs = query.toString();
  return apiFetch<T>("GET", qs ? `${path}?${qs}` : path);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>("POST", path, body);
}

export class HttpSentinelClient implements SentinelClient {
  getSystemHealth(): Promise<ClusterMetrics> {
    return get<ClusterMetrics>("/api/system/health");
  }

  getServices(): Promise<Service[]> {
    return get<Service[]>("/api/services");
  }

  getServiceMetrics(id: string): Promise<ServiceMetricsResult> {
    // TODO(backend): shape may differ (e.g. { service, samples, window }).
    return get<ServiceMetricsResult>(`/api/services/${encodeURIComponent(id)}/metrics`);
  }

  getIncidents(): Promise<Incident[]> {
    return get<Incident[]>("/api/incidents");
  }

  getIncident(id: string): Promise<Incident | null> {
    return get<Incident | null>(`/api/incidents/${encodeURIComponent(id)}`);
  }

  getLogs(query?: LogsQuery): Promise<LogEntry[]> {
    return get<LogEntry[]>("/api/logs", {
      level: query?.level,
      service: query?.service,
      search: query?.search,
      limit: query?.limit?.toString(),
    });
  }

  getAnomalies(): Promise<Anomaly[]> {
    return get<Anomaly[]>("/api/anomalies");
  }

  getRemediationPolicies(): Promise<RemediationPolicy[]> {
    return get<RemediationPolicy[]>("/api/remediation/policies");
  }

  executeRemediation(input: RemediationExecuteInput): Promise<RemediationExecution> {
    return post<RemediationExecution>("/api/remediation/execute", input);
  }

  async injectChaos(input: ChaosInjectInput): Promise<ChaosInjectResult> {
    // Callers fire-and-forget; the backend explains a refusal with a toast.
    try {
      return await post<ChaosInjectResult>("/api/chaos/inject", input);
    } catch {
      return { accepted: false };
    }
  }

  getMlStatus(): Promise<MlStatus> {
    return get<MlStatus>("/api/ml/status");
  }
}
