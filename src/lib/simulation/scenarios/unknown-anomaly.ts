import type { ScenarioDefinition } from "../scenario-runner";

/**
 * Unknown-anomaly scenario — SKELETON.
 *
 * Anomalous behaviour on `orders-service` that the diagnoser cannot match to a
 * known fault signature. Per SPEC §36 this ends ESCALATED (manual approval),
 * NOT auto-healed: the metrics stay degraded until an operator acts / Reset is
 * pressed. Full choreography comes later; this runs end-to-end today.
 */
const TARGET = "orders-service";

export const unknownAnomalyScenario: ScenarioDefinition = {
  id: "unknown-anomaly",
  title: "Unknown Anomaly",
  faultType: "unknown",
  target: TARGET,
  steps: [
    {
      atMs: 0,
      label: "inject",
      run: (ctx) => {
        ctx.setPhase("injecting");
        ctx.setServiceStatus(TARGET, "degraded");
        ctx.setServiceTarget(TARGET, { cpu: 84, latencyP95: 360, errorRate: 2.6 });
        ctx.pushEvent("incident", "Fault injected: unclassified anomaly in orders-service", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("WARN", TARGET, "Irregular behaviour across multiple signals");
      },
    },
    {
      atMs: 2500,
      label: "threshold-breach",
      run: (ctx) => {
        ctx.setDetector("threshold", {
          fired: true,
          firedAt: ctx.now(),
          value: 80,
          detail: "cpu > 80%",
        });
        ctx.setAnomaly({ score: 0.6, baseline: "elevated", serviceId: TARGET });
        ctx.pushEvent("anomaly", "Anomaly scan flagged orders-service", {
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
        ctx.setDetector("ml", { fired: true, firedAt: ctx.now(), value: 0.88 });
        ctx.setAnomaly({
          score: 0.88,
          baseline: "abnormal",
          serviceId: TARGET,
          detectedAt: ctx.now(),
          note: "Unclassified abnormal behaviour in orders-service.",
        });
        ctx.setIsland("anomaly");
      },
    },
    {
      atMs: 6000,
      label: "diagnose",
      run: (ctx) => {
        ctx.setPhase("diagnosing");
        ctx.setIsland("diagnosing");
        // Low signature match → no safe automatic policy applies.
        ctx.setDiagnosis({
          signature: "UNKNOWN",
          match: 0.34,
          faultType: "unknown",
          summary: "No known fault signature matched the deviation.",
        });
        ctx.pushTerminal("classification: unknown", "warn");
        ctx.pushTerminal("no matching signature — escalation required", "warn");
      },
    },
    {
      atMs: 8000,
      label: "escalated",
      run: (ctx) => {
        ctx.setPhase("escalated");
        ctx.setIsland("escalated");
        ctx.pushTerminal("ESCALATED — awaiting operator approval", "error");
        ctx.pushEvent("incident", "Escalated to operator — manual approval required", {
          severity: "crit",
          serviceId: TARGET,
        });
      },
    },
  ],
};
