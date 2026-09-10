import type { ScenarioDefinition } from "../scenario-runner";

/**
 * Memory-leak scenario — SKELETON.
 *
 * A minimal but complete observe→detect→diagnose→remediate→verify→resolve
 * timeline for `payment-worker`, ending AUTO-HEALED. The full cinematic
 * choreography (per-second metric ramps, toasts, incident record, experiment
 * row) lands in a later phase; for now this runs end-to-end and cleanly
 * restores baseline so the engine can be verified.
 *
 * Times are scaled ms (compressed by the engine's timeScale).
 */
const TARGET = "payment-worker";

export const memoryLeakScenario: ScenarioDefinition = {
  id: "memory-leak",
  title: "Memory Leak",
  faultType: "memory_growth",
  target: TARGET,
  steps: [
    {
      atMs: 0,
      label: "inject",
      run: (ctx) => {
        ctx.setPhase("injecting");
        ctx.setServiceStatus(TARGET, "degraded");
        ctx.setServiceTarget(TARGET, { memory: 78, latencyP95: 320, errorRate: 2.4 });
        ctx.pushEvent("incident", "Fault injected: memory leak in payment-worker", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("WARN", TARGET, "Heap usage climbing above baseline");
      },
    },
    {
      atMs: 2500,
      label: "threshold-breach",
      run: (ctx) => {
        ctx.setServiceTarget(TARGET, { memory: 91, latencyP95: 640, errorRate: 5.1 });
        ctx.setDetector("threshold", {
          fired: true,
          firedAt: ctx.now(),
          value: 90,
          detail: "memory > 90%",
        });
        ctx.setAnomaly({ score: 0.55, baseline: "elevated", serviceId: TARGET });
        ctx.pushEvent("anomaly", "Abnormal memory gradient detected", {
          severity: "ai",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 4000,
      label: "detected",
      run: (ctx) => {
        ctx.setPhase("detected");
        ctx.setServiceStatus(TARGET, "critical");
        ctx.setServiceTarget(TARGET, { memory: 95, latencyP95: 880, errorRate: 8.4 });
        ctx.setDetector("ml", { fired: true, firedAt: ctx.now(), value: 0.94 });
        ctx.setAnomaly({
          score: 0.94,
          baseline: "abnormal",
          serviceId: TARGET,
          detectedAt: ctx.now(),
          note: "Abnormal memory growth detected in payment-worker.",
        });
        ctx.setIsland("anomaly");
        ctx.pushEvent("incident", "Incident opened — payment-worker memory anomaly", {
          severity: "crit",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 6000,
      label: "diagnose",
      run: (ctx) => {
        ctx.setPhase("diagnosing");
        ctx.setIsland("diagnosing");
        ctx.setDiagnosis({
          signature: "MEM-LEAK",
          match: 0.9,
          faultType: "memory_growth",
          summary: "Feature deviation matches the memory-leak signature.",
        });
        ctx.pushTerminal("classification: memory_growth", "info");
        ctx.pushTerminal("signature match: MEM-LEAK (0.90)", "info");
      },
    },
    {
      atMs: 8000,
      label: "remediate",
      run: (ctx) => {
        ctx.setPhase("remediating");
        ctx.setIsland("healing");
        ctx.setServiceStatus(TARGET, "recovering");
        // Restart reclaims heap — walk targets return to baseline.
        ctx.resetServiceTarget(TARGET);
        ctx.pushTerminal("action approved: restart_worker", "command");
        ctx.pushTerminal("executing...", "info");
        ctx.pushEvent("remediation", "Restarting payment-worker", {
          severity: "info",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 12000,
      label: "verify",
      run: (ctx) => {
        ctx.setPhase("verifying");
        ctx.setIsland("verifying");
        ctx.pushTerminal("health verification...", "info");
      },
    },
    {
      atMs: 14000,
      label: "resolved",
      run: (ctx) => {
        ctx.setServiceStatus(TARGET, "healthy");
        ctx.resetServiceTarget(TARGET);
        ctx.setAnomaly({
          score: 0.08,
          baseline: "normal",
          serviceId: undefined,
          note: "No abnormal behaviour detected.",
        });
        ctx.setDiagnosis(null);
        ctx.setDetector("threshold", { fired: false, firedAt: null });
        ctx.setDetector("ml", { fired: false, firedAt: null, value: 0.08 });
        ctx.setIsland("recovered");
        ctx.setPhase("resolved");
        ctx.pushTerminal("INCIDENT RESOLVED", "success");
        ctx.pushEvent("verification", "Auto-recovery complete — payment-worker healthy", {
          severity: "ok",
          serviceId: TARGET,
        });
      },
    },
  ],
};
