import type { ScenarioDefinition } from "../scenario-runner";

/**
 * Memory leak on `payment-worker` — the headline demo (SPEC §13, §31).
 *
 * Every offset below is measured from the moment the fault lands (the engine
 * owns the 3-2-1 countdown that precedes it), and `ctx.now()` reports the
 * step's *scheduled* time, so the two numbers the whole demo is judged on come
 * out exact no matter how coarsely the engine ticks:
 *
 *   anomaly detected at +8.2 s   ·   detected → resolved in 18.4 s
 *
 * The static threshold rule is deliberately NOT scripted here: the engine
 * evaluates `memory > 90%` against live telemetry each tick, so it fires later
 * than the detector on its own merits — which is the comparison the research
 * question is actually about.
 */

const TARGET = "payment-worker";
const POLICY = "MEM-LEAK-01";
const ACTION = "restart_container";

/** Detection → resolution, seconds. Kept in one place; the copy quotes it. */
const RECOVERY_SEC = 18.4;

/** Metrics captured when the incident opens, for the before/after comparison. */
const BEFORE = { memory: 91, latencyP95: 700, errorRate: 6.2 };
const AFTER = { memory: 43, latencyP95: 171, errorRate: 0.4 };

/** The single incident this run opens; captured so later steps can update it. */
let incidentId: string | null = null;

export const memoryLeakScenario: ScenarioDefinition = {
  id: "memory-leak",
  title: "Memory Leak",
  faultType: "memory_leak",
  target: TARGET,
  metric: "memory",
  threshold: 90,
  thresholdLabel: "memory > 90%",
  expected: "auto_heal",
  steps: [
    {
      atMs: 0,
      label: "inject",
      run: (ctx) => {
        incidentId = null;
        ctx.step("injected");
        ctx.setServiceMetrics(TARGET, { memory: 61, latencyP95: 210, errorRate: 0.7 });
        ctx.runConsole({ action: null, policyNote: null, diagnosisNote: null });
        ctx.pushEvent("incident", "Fault injected — progressive memory consumption", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("WARN", TARGET, "Heap usage climbing above the learned baseline");
      },
    },
    {
      atMs: 3000,
      label: "ramp-70",
      run: (ctx) => {
        ctx.setServiceMetrics(TARGET, { memory: 70, latencyP95: 300, errorRate: 1.2 });
        ctx.log("WARN", TARGET, "GC pause frequency rising; heap not reclaimed");
      },
    },
    {
      atMs: 6000,
      label: "ramp-82-degraded",
      run: (ctx) => {
        ctx.setServiceMetrics(TARGET, { memory: 82, latencyP95: 460, errorRate: 3.1 });
        ctx.setServiceStatus(TARGET, "degraded");
        ctx.pushEvent("telemetry", "payment-worker degraded — memory above baseline", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("ERROR", TARGET, "Job queue latency degraded under memory pressure");
      },
    },
    {
      atMs: 8200,
      label: "ml-detected",
      run: (ctx) => {
        // Stage 1: the Isolation Forest scores the deviation. It says "this is
        // abnormal", nothing more — the fault type comes from the Diagnoser.
        ctx.setDetector("ml", { fired: true, firedAt: ctx.now(), value: 0.94 });
        ctx.setAnomaly({
          score: 0.94,
          baseline: "abnormal",
          serviceId: TARGET,
          detectedAt: ctx.now(),
          note: "Memory growth rate exceeded the learned baseline envelope.",
          contributions: [
            { feature: "Memory growth", weight: 52 },
            { feature: "Error rate", weight: 21 },
            { feature: "P95 latency", weight: 17 },
            { feature: "CPU", weight: 7 },
            { feature: "Throughput", weight: 3 },
          ],
        });
        ctx.step("detected");
        ctx.setIsland("anomaly");

        incidentId = ctx.openIncident({
          title: "Memory leak",
          serviceId: TARGET,
          severity: "critical",
          rootCause: "Progressive memory growth",
          action: "Restart container",
          anomalyScore: 0.94,
          before: BEFORE,
        });

        ctx.pushTerminal("anomaly detected", "warn");
        ctx.pushEvent("incident", `${incidentId} opened — payment-worker memory anomaly`, {
          severity: "crit",
          serviceId: TARGET,
        });
        ctx.notify(
          "warning",
          "Abnormal behaviour detected",
          "payment-worker memory exceeded learned baseline.",
        );
      },
    },
    {
      atMs: 9000,
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
          serviceId: TARGET,
        });
        ctx.notify(
          "info",
          "SentinelOps is investigating",
          "Analyzing payment-worker telemetry.",
        );
      },
    },
    {
      atMs: 10000,
      label: "ramp-91-critical",
      run: (ctx) => {
        ctx.setServiceMetrics(TARGET, { memory: 91, latencyP95: 700, errorRate: 6.2 });
        ctx.setServiceStatus(TARGET, "critical");
        ctx.pushEvent("telemetry", "payment-worker critical — memory 91%", {
          severity: "crit",
          serviceId: TARGET,
        });
        ctx.log("ERROR", TARGET, "OOM risk: heap at 91% of container limit");
      },
    },
    {
      atMs: 12000,
      label: "diagnosis-and-policy",
      run: (ctx) => {
        // Stage 2: the Diagnoser matches feature deviation against known fault
        // signatures. This is a signature match, never a "confidence".
        ctx.setDiagnosis({
          signature: "MEM-LEAK",
          match: 0.96,
          faultType: "memory_leak",
          summary: "Feature deviation matches the memory-leak signature.",
        });
        ctx.pushTerminal("classification: memory_leak", "info");
        ctx.pushTerminal("signature match: 0.96", "info");
        ctx.runConsole({ diagnosisNote: "memory_leak · signature match 96%" });
        if (incidentId) {
          ctx.completeStage(incidentId, "analyzed", "Signature match 96% — memory_leak.");
          ctx.startStage(incidentId, "policy_check");
        }

        ctx.step("policy_check");
        ctx.pushTerminal(`evaluating remediation policy ${POLICY}`, "command");
        ctx.runConsole({
          policyNote: `Safe automatic action available: ${ACTION} (${POLICY})`,
        });
      },
    },
    {
      atMs: 13000,
      label: "ramp-peak",
      run: (ctx) => {
        ctx.setServiceMetrics(TARGET, { memory: 96, latencyP95: 884, errorRate: 8.7 });
      },
    },
    {
      atMs: 14000,
      label: "remediating",
      run: (ctx) => {
        ctx.pushTerminal(`action approved: ${ACTION}`, "command");
        ctx.pushTerminal("executing...", "info");
        ctx.step("remediating");
        ctx.setIsland("healing");
        ctx.setServiceStatus(TARGET, "recovering");
        ctx.setContainerStatus(TARGET, "restarting");
        ctx.runConsole({ action: ACTION });
        if (incidentId) {
          ctx.completeStage(
            incidentId,
            "policy_check",
            `Safe automatic action available: ${ACTION} (${POLICY}).`,
          );
          ctx.startStage(incidentId, "remediation", `${ACTION} on ${TARGET}`);
          ctx.updateIncident(incidentId, { status: "auto_healing" });
        }
        ctx.pushEvent("remediation", `Restarting payment-worker — policy ${POLICY}`, {
          severity: "ai",
          serviceId: TARGET,
        });
        ctx.log("INFO", TARGET, "SIGTERM received; draining in-flight jobs");
      },
    },
    {
      atMs: 18000,
      label: "restarted",
      run: (ctx) => {
        ctx.pushTerminal("payment-worker restarted", "success");
        ctx.setContainerStatus(TARGET, "running");
        // The restart reclaims the heap: targets drop back below baseline.
        ctx.setServiceMetrics(TARGET, {
          memory: AFTER.memory,
          latencyP95: AFTER.latencyP95,
          errorRate: AFTER.errorRate,
        });
        ctx.pushEvent("remediation", "payment-worker restarted — heap reclaimed", {
          severity: "ok",
          serviceId: TARGET,
        });
        ctx.log("INFO", TARGET, "Worker process restarted; heap reset to 43%");
        if (incidentId) {
          ctx.completeStage(incidentId, "remediation", `${ACTION} completed.`);
        }
      },
    },
    {
      atMs: 22000,
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
    {
      atMs: 22600,
      label: "check-1",
      run: (ctx) => ctx.healthCheck("Liveness probe · 200 OK"),
    },
    {
      atMs: 23600,
      label: "check-2",
      run: (ctx) => ctx.healthCheck("Memory below baseline envelope"),
    },
    {
      atMs: 24600,
      label: "check-3",
      run: (ctx) => ctx.healthCheck("Job queue drained · error rate 0.4%"),
    },
    {
      atMs: 26000,
      label: "verified",
      run: (ctx) => {
        ctx.pushTerminal("health verification passed", "success");
        ctx.pushEvent("verification", "3 of 3 health checks passed", {
          severity: "ok",
          serviceId: TARGET,
        });
        if (incidentId) {
          ctx.completeStage(incidentId, "verification", "3 of 3 health checks passed.");
        }
      },
    },
    {
      atMs: 26600,
      label: "resolved",
      run: (ctx) => {
        ctx.setServiceStatus(TARGET, "healthy");
        ctx.resetServiceTarget(TARGET);
        ctx.step("resolved");
        ctx.setIsland("recovered");
        ctx.runConsole({ recoverySec: RECOVERY_SEC });
        if (incidentId) {
          ctx.updateIncident(incidentId, {
            status: "resolved",
            auto: true,
            resolvedAt: ctx.now(),
            recoverySec: RECOVERY_SEC,
            after: AFTER,
          });
          ctx.completeStage(incidentId, "resolved", "Auto-healed.");
        }
        ctx.pushTerminal("INCIDENT RESOLVED", "success");
        ctx.pushEvent("verification", "Auto-recovery complete — payment-worker healthy", {
          severity: "ok",
          serviceId: TARGET,
        });
        ctx.log("INFO", TARGET, "Service healthy; incident auto-resolved");
        ctx.notify(
          "success",
          "Auto-recovery completed",
          `payment-worker returned to normal in ${RECOVERY_SEC}s.`,
        );
      },
    },
    {
      atMs: 28000,
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
      atMs: 32000,
      label: "watch",
      run: (ctx) => {
        ctx.pushEvent("health", "Post-incident watch — payment-worker stable", {
          severity: "ok",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 36000,
      label: "closed",
      run: (ctx) => {
        ctx.pushEvent("info", "Post-incident watch window closed", { severity: "info" });
        ctx.log("INFO", TARGET, "Post-incident watch window closed");
      },
    },
  ],
};
