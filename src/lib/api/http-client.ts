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

/**
 * HTTP client for the future FastAPI backend. Selected only when
 * NEXT_PUBLIC_DATA_SOURCE === "http". There is deliberately NO fake backend —
 * these methods call the real endpoints from SPEC §32. Until the backend
 * exists, `api` defaults to the mock client, so this code path is dormant.
 *
 * TODO(backend): finalise request/response shapes, auth headers, error model,
 * pagination and websocket/SSE streaming for logs + live telemetry once FastAPI
 * lands. Keep the return types identical to MockSentinelClient.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
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

  injectChaos(input: ChaosInjectInput): Promise<ChaosInjectResult> {
    return post<ChaosInjectResult>("/api/chaos/inject", input);
  }

  getMlStatus(): Promise<MlStatus> {
    return get<MlStatus>("/api/ml/status");
  }
}
