import type {
  Anomaly,
  ClusterMetrics,
  FeatureContribution,
  Incident,
  LogEntry,
  RemediationExecution,
  RemediationPolicy,
  Service,
} from "@/lib/types";
import { sentinelStore } from "@/lib/store/sentinel-store";
import { engine } from "@/lib/simulation/engine";
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
 * Simulation-backed client. Reads live state from the Zustand store and routes
 * commands to the engine. Every method is async so swapping in the real
 * http-client is a no-op for callers.
 */

const DEFAULT_CONTRIBUTIONS: FeatureContribution[] = [
  { feature: "Memory Growth", weight: 44 },
  { feature: "Error Rate", weight: 24 },
  { feature: "Latency", weight: 18 },
  { feature: "CPU", weight: 9 },
  { feature: "Throughput", weight: 5 },
];

export class MockSentinelClient implements SentinelClient {
  async getSystemHealth(): Promise<ClusterMetrics> {
    return sentinelStore.get().cluster;
  }

  async getServices(): Promise<Service[]> {
    return sentinelStore.get().services;
  }

  async getServiceMetrics(id: string): Promise<ServiceMetricsResult> {
    const state = sentinelStore.get();
    return {
      service: state.services.find((s) => s.id === id) ?? null,
      samples: state.histories[id] ?? [],
    };
  }

  async getIncidents(): Promise<Incident[]> {
    // Newest first.
    return [...sentinelStore.get().incidents].sort((a, b) => b.detectedAt - a.detectedAt);
  }

  async getIncident(id: string): Promise<Incident | null> {
    return sentinelStore.get().incidents.find((i) => i.id === id) ?? null;
  }

  async getLogs(query?: LogsQuery): Promise<LogEntry[]> {
    let logs = sentinelStore.get().logs;
    if (query?.level) logs = logs.filter((l) => l.level === query.level);
    if (query?.service) logs = logs.filter((l) => l.service === query.service);
    if (query?.search) {
      const q = query.search.toLowerCase();
      logs = logs.filter((l) => l.message.toLowerCase().includes(q));
    }
    if (query?.limit) logs = logs.slice(-query.limit);
    return logs;
  }

  async getAnomalies(): Promise<Anomaly[]> {
    return [sentinelStore.get().anomaly];
  }

  async getRemediationPolicies(): Promise<RemediationPolicy[]> {
    return sentinelStore.get().policies;
  }

  async executeRemediation(
    input: RemediationExecuteInput,
  ): Promise<RemediationExecution> {
    const state = sentinelStore.get();
    const policy = state.policies.find((p) => p.id === input.policyId);
    const dryRun = input.dryRun ?? state.settings.dryRun;
    const outcome = policy?.mode === "manual" ? "escalated" : "success";
    const now = Date.now();

    // NOTE: skeleton — real execution choreography (terminal streaming, guardrail
    // checks, before/after capture) is driven by scenarios in a later phase.
    return {
      id: `EXEC-${now}`,
      incidentId: input.incidentId ?? "",
      policyId: input.policyId,
      serviceId: input.serviceId,
      action: policy?.action ?? "unknown",
      startedAt: now,
      completedAt: now,
      outcome,
      dryRun,
      lines: [],
    };
  }

  async injectChaos(input: ChaosInjectInput): Promise<ChaosInjectResult> {
    engine.runScenario(input.scenario);
    return { accepted: true };
  }

  async getMlStatus(): Promise<MlStatus> {
    const state = sentinelStore.get();
    return {
      model: "Isolation Forest",
      // No trained model ships with this build; the UI says so too.
      status: "training",
      baselineWindowHours: state.settings.baselineWindowHours,
      anomalyScore: state.anomaly.score,
      detectors: state.detectors,
      contributions: state.anomaly.contributions ?? DEFAULT_CONTRIBUTIONS,
      // Academic honesty: never fabricate research metrics.
      research: {
        precision: null,
        recall: null,
        f1: null,
        falsePositiveRate: null,
        mttdImprovement: null,
        mttrImprovement: null,
      },
    };
  }
}
