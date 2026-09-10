import type { IncidentSeverity, ServiceMetrics } from "@/lib/types";
import type { ScenarioDefinition, ScenarioMetric, ScenarioStep } from "../scenario-runner";

/**
 * Reusable step builder for the short chaos runs.
 *
 * Every fault that ends in a safe automatic action tells the same story —
 * ramp the metric, detect, diagnose, check policy, act, verify, resolve — so
 * the timeline lives here once and each fault only supplies its content. The
 * memory-leak and unknown-anomaly scenarios are hand-written instead: they are
 * the two the demo is built around and they deviate from this shape.
 *
 * Offsets are ms from injection (the engine owns the 3-2-1 countdown), giving
 * a ~29 s run end to end. They are nominal: the engine warps them onto the
 * run's minted timing, so quoted durations come from `ctx.timing`.
 */

const T = {
  ramp2: 2500,
  ramp3: 5000,
  detect: 6000,
  analyze: 6800,
  diagnose: 9000,
  remediate: 11000,
  acted: 14000,
  verify: 17000,
  check1: 17600,
  check2: 18400,
  check3: 19200,
  verified: 20000,
  resolve: 20400,
  decay: 22000,
  end: 26000,
} as const;

export interface StandardScenarioConfig {
  id: ScenarioDefinition["id"];
  title: string;
  target: string;
  faultType: string;
  metric: ScenarioMetric;
  threshold: number;
  thresholdLabel: string;

  /** Three ramp stages: onset, degraded, peak. */
  ramp: [Partial<ServiceMetrics>, Partial<ServiceMetrics>, Partial<ServiceMetrics>];
  /** Walk targets once the action has taken effect. */
  after: Partial<ServiceMetrics>;

  /** Anomaly score the detector reports. */
  anomalyScore: number;
  contributions: { feature: string; weight: number }[];

  signature: string;
  /** Signature match, 0–1. Must clear the 0.7 policy floor. */
  match: number;
  diagnosisSummary: string;

  policyId: string;
  /** Machine action name, e.g. "restart_container". */
  actionKind: string;
  /** Sentence-case action for the incident record, e.g. "Restart container". */
  actionLabel: string;
  /** Terminal line for the moment the action lands. */
  actedLine: string;

  incidentTitle: string;
  incidentSeverity: IncidentSeverity;
  rootCause: string;

  /** Whether the action cycles the container (restart vs scale/flush). */
  cyclesContainer: boolean;

  /** Three post-action health checks. */
  healthChecks: [string, string, string];
  /** Log lines: onset, action, resolved. */
  logs: { onset: string; action: string; resolved: string };
}

export function buildStandardScenario(
  cfg: StandardScenarioConfig,
): ScenarioDefinition {
  let incidentId: string | null = null;

  const steps: ScenarioStep[] = [
    {
      atMs: 0,
      label: "inject",
      run: (ctx) => {
        incidentId = null;
        ctx.step("injected");
        ctx.runConsole({ action: null, policyNote: null, diagnosisNote: null });
        ctx.setServiceMetrics(cfg.target, cfg.ramp[0]);
        ctx.pushEvent("incident", `Fault injected — ${cfg.title} on ${cfg.target}`, {
          severity: "warn",
          serviceId: cfg.target,
        });
        ctx.log("WARN", cfg.target, cfg.logs.onset);
      },
    },
    {
      atMs: T.ramp2,
      label: "degraded",
      run: (ctx) => {
        ctx.setServiceMetrics(cfg.target, cfg.ramp[1]);
        ctx.setServiceStatus(cfg.target, "degraded");
        ctx.pushEvent("telemetry", `${cfg.target} degraded`, {
          severity: "warn",
          serviceId: cfg.target,
        });
      },
    },
    {
      atMs: T.ramp3,
      label: "critical",
      run: (ctx) => {
        ctx.setServiceMetrics(cfg.target, cfg.ramp[2]);
        ctx.setServiceStatus(cfg.target, "critical");
        ctx.pushEvent("telemetry", `${cfg.target} critical`, {
          severity: "crit",
          serviceId: cfg.target,
        });
      },
    },
    {
      atMs: T.detect,
      label: "detected",
      run: (ctx) => {
        ctx.setDetector("ml", {
          fired: true,
          firedAt: ctx.now(),
          value: cfg.anomalyScore,
        });
        ctx.setAnomaly({
          score: cfg.anomalyScore,
          baseline: "abnormal",
          serviceId: cfg.target,
          detectedAt: ctx.now(),
          note: `Abnormal behaviour detected in ${cfg.target}.`,
          contributions: cfg.contributions,
        });
        ctx.step("detected");
        ctx.setIsland("anomaly");

        incidentId = ctx.openIncident({
          title: cfg.incidentTitle,
          serviceId: cfg.target,
          severity: cfg.incidentSeverity,
          rootCause: cfg.rootCause,
          action: cfg.actionLabel,
          anomalyScore: cfg.anomalyScore,
          before: ctx.snapshot(cfg.target),
        });

        ctx.pushTerminal("anomaly detected", "warn");
        ctx.pushEvent("incident", `${incidentId} opened — ${cfg.target}`, {
          severity: "crit",
          serviceId: cfg.target,
        });
      },
    },
    {
      atMs: T.analyze,
      label: "analyzing",
      run: (ctx) => {
        ctx.step("analyzing");
        ctx.setIsland("diagnosing");
        if (incidentId) {
          ctx.updateIncident(incidentId, { status: "investigating" });
          ctx.startStage(incidentId, "analyzed", "Matching deviation to fault signatures.");
        }
        ctx.pushEvent("anomaly", "Analyzing telemetry — matching fault signatures", {
          severity: "ai",
          serviceId: cfg.target,
        });
      },
    },
    {
      atMs: T.diagnose,
      label: "diagnosis-and-policy",
      run: (ctx) => {
        const diagnosis = {
          signature: cfg.signature,
          match: cfg.match,
          faultType: cfg.faultType,
          summary: cfg.diagnosisSummary,
        };
        ctx.setDiagnosis(diagnosis);
        // The incident keeps its own copy: the live diagnosis decays.
        if (incidentId) {
          ctx.updateIncident(incidentId, { diagnosis, policyId: cfg.policyId });
        }
        ctx.pushTerminal(`classification: ${cfg.faultType}`, "info");
        ctx.pushTerminal(`signature match: ${cfg.match.toFixed(2)}`, "info");
        ctx.runConsole({
          diagnosisNote: `${cfg.faultType} · signature match ${Math.round(cfg.match * 100)}%`,
        });
        if (incidentId) {
          ctx.completeStage(
            incidentId,
            "analyzed",
            `Signature match ${Math.round(cfg.match * 100)}% — ${cfg.faultType}.`,
          );
          ctx.startStage(incidentId, "policy_check");
        }

        ctx.step("policy_check");
        ctx.pushTerminal(`evaluating remediation policy ${cfg.policyId}`, "command");
        ctx.runConsole({
          policyNote: `Safe automatic action available: ${cfg.actionKind} (${cfg.policyId})`,
        });
      },
    },
    {
      atMs: T.remediate,
      label: "remediating",
      run: (ctx) => {
        ctx.pushTerminal(`action approved: ${cfg.actionKind}`, "command");
        ctx.pushTerminal("executing...", "info");
        ctx.step("remediating");
        ctx.setIsland("healing");
        ctx.setServiceStatus(cfg.target, "recovering");
        if (cfg.cyclesContainer) ctx.setContainerStatus(cfg.target, "restarting");
        ctx.runConsole({ action: cfg.actionKind });
        if (incidentId) {
          ctx.completeStage(
            incidentId,
            "policy_check",
            `Safe automatic action available: ${cfg.actionKind} (${cfg.policyId}).`,
          );
          ctx.startStage(incidentId, "remediation", `${cfg.actionKind} on ${cfg.target}`);
          ctx.updateIncident(incidentId, { status: "auto_healing" });
        }
        ctx.pushEvent("remediation", `${cfg.actionLabel} — policy ${cfg.policyId}`, {
          severity: "ai",
          serviceId: cfg.target,
        });
        ctx.log("INFO", cfg.target, cfg.logs.action);
      },
    },
    {
      atMs: T.acted,
      label: "acted",
      run: (ctx) => {
        ctx.pushTerminal(cfg.actedLine, "success");
        if (cfg.cyclesContainer) ctx.setContainerStatus(cfg.target, "running");
        ctx.setServiceMetrics(cfg.target, cfg.after);
        ctx.pushEvent("remediation", cfg.actedLine, {
          severity: "ok",
          serviceId: cfg.target,
        });
        if (incidentId) {
          ctx.completeStage(incidentId, "remediation", `${cfg.actionKind} completed.`);
        }
      },
    },
    {
      atMs: T.verify,
      label: "verifying",
      run: (ctx) => {
        ctx.step("verifying");
        ctx.setIsland("verifying");
        if (incidentId) {
          ctx.updateIncident(incidentId, { status: "verifying" });
          ctx.startStage(incidentId, "verification");
        }
        ctx.pushTerminal("health verification...", "info");
      },
    },
    { atMs: T.check1, run: (ctx) => ctx.healthCheck(cfg.healthChecks[0]) },
    { atMs: T.check2, run: (ctx) => ctx.healthCheck(cfg.healthChecks[1]) },
    { atMs: T.check3, run: (ctx) => ctx.healthCheck(cfg.healthChecks[2]) },
    {
      atMs: T.verified,
      label: "verified",
      run: (ctx) => {
        ctx.pushTerminal("health verification passed", "success");
        ctx.pushEvent("verification", "3 of 3 health checks passed", {
          severity: "ok",
          serviceId: cfg.target,
        });
        if (incidentId) {
          ctx.completeStage(incidentId, "verification", "3 of 3 health checks passed.");
        }
      },
    },
    {
      atMs: T.resolve,
      label: "resolved",
      run: (ctx) => {
        ctx.setServiceStatus(cfg.target, "healthy");
        ctx.resetServiceTarget(cfg.target);
        ctx.step("resolved");
        ctx.setIsland("recovered");
        ctx.runConsole({ recoverySec: ctx.timing().recoverySec });
        if (incidentId) {
          ctx.updateIncident(incidentId, {
            status: "resolved",
            auto: true,
            resolvedAt: ctx.now(),
            recoverySec: ctx.timing().recoverySec,
            after: ctx.snapshot(cfg.target),
          });
          ctx.completeStage(incidentId, "resolved", "Auto-healed.");
        }
        ctx.pushTerminal("INCIDENT RESOLVED", "success");
        ctx.pushEvent("verification", `Auto-recovery complete — ${cfg.target} healthy`, {
          severity: "ok",
          serviceId: cfg.target,
        });
        ctx.log("INFO", cfg.target, cfg.logs.resolved);
      },
    },
    {
      atMs: T.decay,
      label: "decay",
      run: (ctx) => {
        ctx.setAnomaly({
          score: 0.08,
          baseline: "normal",
          serviceId: undefined,
          detectedAt: undefined,
          note: "No abnormal behaviour detected.",
          contributions: undefined,
        });
        ctx.setDiagnosis(null);
        ctx.setDetector("threshold", { fired: false, firedAt: null });
        ctx.setDetector("ml", { fired: false, firedAt: null, value: 0.08 });
      },
    },
    {
      atMs: T.end,
      label: "closed",
      run: (ctx) => {
        ctx.pushEvent("info", "Post-incident watch window closed", { severity: "info" });
      },
    },
  ];

  return {
    id: cfg.id,
    title: cfg.title,
    faultType: cfg.faultType,
    target: cfg.target,
    metric: cfg.metric,
    threshold: cfg.threshold,
    thresholdLabel: cfg.thresholdLabel,
    expected: "auto_heal",
    nominal: { detectAtMs: T.detect, endAtMs: T.resolve },
    steps,
  };
}

/* ------------------------------------------------------------------ */
/* The four short faults                                               */
/* ------------------------------------------------------------------ */

export const cpuSpikeScenario = buildStandardScenario({
  id: "cpu-spike",
  title: "CPU Spike",
  target: "api-gateway",
  faultType: "cpu_saturation",
  metric: "cpu",
  threshold: 85,
  thresholdLabel: "cpu > 85%",
  ramp: [
    { cpu: 74, latencyP95: 210, errorRate: 0.6 },
    { cpu: 89, latencyP95: 356, errorRate: 1.4 },
    { cpu: 96, latencyP95: 512, errorRate: 2.4 },
  ],
  after: { cpu: 54, latencyP95: 168, errorRate: 0.4 },
  anomalyScore: 0.87,
  contributions: [
    { feature: "CPU", weight: 48 },
    { feature: "P95 latency", weight: 26 },
    { feature: "Error rate", weight: 14 },
    { feature: "Throughput", weight: 8 },
    { feature: "Memory", weight: 4 },
  ],
  signature: "CPU-SAT",
  match: 0.91,
  diagnosisSummary: "Sustained CPU saturation under load, no memory involvement.",
  policyId: "CPU-SAT-01",
  actionKind: "scale_replicas",
  actionLabel: "Scale replicas",
  actedLine: "api-gateway scaled to 3 replicas",
  incidentTitle: "CPU saturation",
  incidentSeverity: "warning",
  rootCause: "Sustained CPU saturation",
  cyclesContainer: false,
  healthChecks: [
    "Replica 3 ready · 200 OK",
    "CPU back inside baseline envelope",
    "P95 latency below 500 ms",
  ],
  logs: {
    onset: "CPU saturation across gateway workers",
    action: "Scaling deployment to 3 replicas",
    resolved: "Load spread across 3 replicas; incident auto-resolved",
  },
});

export const serviceCrashScenario = buildStandardScenario({
  id: "service-crash",
  title: "Service Crash",
  target: "payment-worker",
  faultType: "service_crash",
  metric: "errorRate",
  threshold: 5,
  thresholdLabel: "error rate > 5%",
  ramp: [
    { errorRate: 6.4, latencyP95: 420, throughput: 310 },
    { errorRate: 34.2, latencyP95: 980, throughput: 96 },
    { errorRate: 61.5, latencyP95: 1420, throughput: 12 },
  ],
  after: { errorRate: 0.4, latencyP95: 188, throughput: 486 },
  anomalyScore: 0.93,
  contributions: [
    { feature: "Error rate", weight: 51 },
    { feature: "Throughput", weight: 24 },
    { feature: "P95 latency", weight: 17 },
    { feature: "CPU", weight: 5 },
    { feature: "Memory", weight: 3 },
  ],
  signature: "CRASH",
  match: 0.94,
  diagnosisSummary: "Process exited and failed liveness checks.",
  policyId: "CRASH-01",
  actionKind: "restart_container",
  actionLabel: "Restart container",
  actedLine: "payment-worker container restarted",
  incidentTitle: "Service crash",
  incidentSeverity: "critical",
  rootCause: "Process exited unexpectedly",
  cyclesContainer: true,
  healthChecks: [
    "Liveness probe · 200 OK",
    "Job queue consuming again",
    "Error rate below 1%",
  ],
  logs: {
    onset: "Worker process exited with code 137",
    action: "Restarting container 9d40b7c1e5a8",
    resolved: "Container healthy; incident auto-resolved",
  },
});

export const latencyInjectionScenario = buildStandardScenario({
  id: "latency-injection",
  title: "Latency Injection",
  target: "orders-service",
  faultType: "latency_spike",
  metric: "latencyP95",
  threshold: 500,
  thresholdLabel: "p95 > 500 ms",
  ramp: [
    { latencyP95: 480, cpu: 62, errorRate: 0.9 },
    { latencyP95: 910, cpu: 71, errorRate: 2.2 },
    { latencyP95: 1360, cpu: 78, errorRate: 3.8 },
  ],
  after: { latencyP95: 174, cpu: 57, errorRate: 0.6 },
  anomalyScore: 0.9,
  contributions: [
    { feature: "P95 latency", weight: 56 },
    { feature: "Error rate", weight: 18 },
    { feature: "CPU", weight: 13 },
    { feature: "Throughput", weight: 9 },
    { feature: "Memory", weight: 4 },
  ],
  signature: "LATENCY-BURST",
  match: 0.86,
  diagnosisSummary: "Artificial response delay in the request path; CPU normal.",
  policyId: "CRASH-01",
  actionKind: "restart_container",
  actionLabel: "Restart container",
  actedLine: "orders-service container restarted",
  incidentTitle: "Latency spike",
  incidentSeverity: "warning",
  rootCause: "Injected response delay",
  cyclesContainer: true,
  healthChecks: [
    "Liveness probe · 200 OK",
    "P95 latency below 500 ms",
    "Error rate below 1%",
  ],
  logs: {
    onset: "Response times rising with no CPU or memory pressure",
    action: "Restarting container 5c1b9d3e7a26",
    resolved: "Latency back to baseline; incident auto-resolved",
  },
});

export const cacheSaturationScenario = buildStandardScenario({
  id: "cache-saturation",
  title: "Cache Saturation",
  target: "redis-cache",
  faultType: "cache_saturation",
  metric: "memory",
  threshold: 90,
  thresholdLabel: "memory > 90%",
  ramp: [
    { memory: 78, hitRate: 91.2, latencyP95: 14 },
    { memory: 89, hitRate: 81.6, latencyP95: 24 },
    { memory: 95, hitRate: 71.4, latencyP95: 34 },
  ],
  after: { memory: 64, hitRate: 96.5, latencyP95: 8 },
  anomalyScore: 0.84,
  contributions: [
    { feature: "Memory", weight: 44 },
    { feature: "Hit rate", weight: 31 },
    { feature: "P95 latency", weight: 15 },
    { feature: "Throughput", weight: 6 },
    { feature: "CPU", weight: 4 },
  ],
  signature: "CACHE-SAT",
  match: 0.89,
  diagnosisSummary: "Memory pressure with a falling hit rate — eviction needed.",
  policyId: "CACHE-SAT-01",
  actionKind: "clear_cache",
  actionLabel: "Clear cache",
  actedLine: "redis-cache flushed — 1.4 GB reclaimed",
  incidentTitle: "Cache saturation",
  incidentSeverity: "warning",
  rootCause: "Redis memory pressure",
  cyclesContainer: false,
  healthChecks: [
    "Redis PING · PONG",
    "Memory below baseline envelope",
    "Hit rate back above 95%",
  ],
  logs: {
    onset: "Redis memory pressure; eviction rate climbing",
    action: "Issuing scoped cache eviction",
    resolved: "Hit rate restored; incident auto-resolved",
  },
});
