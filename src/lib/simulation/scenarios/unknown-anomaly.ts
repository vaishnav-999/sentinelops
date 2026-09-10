import type { ScenarioDefinition } from "../scenario-runner";

/**
 * Unknown anomaly on `orders-service` (SPEC §36).
 *
 * Weak, mixed signals: no single metric ever crosses its static threshold, so
 * the rule-based detector stays silent for the whole run while the anomaly
 * detector still flags the combination. The Diagnoser then fails to match any
 * known fault signature (41%, well under the 70% policy floor), so there is no
 * safe automatic action and the run ends ESCALATED — never auto-healed.
 *
 * The service drifts back to normal on its own afterwards, but the incident
 * deliberately stays escalated: only an operator (or Reset Demo) closes it.
 */

const TARGET = "orders-service";

/** Signature match below this floor means no automatic policy may run. */
const POLICY_FLOOR = 0.7;
const MATCH = 0.41;

let incidentId: string | null = null;

export const unknownAnomalyScenario: ScenarioDefinition = {
  id: "unknown-anomaly",
  title: "Unknown Anomaly",
  faultType: "unknown",
  target: TARGET,
  metric: "cpu",
  threshold: 85,
  thresholdLabel: "cpu > 85%",
  expected: "escalate",
  nominal: { detectAtMs: 7500, endAtMs: 14500 },
  steps: [
    {
      atMs: 0,
      label: "inject",
      run: (ctx) => {
        incidentId = null;
        ctx.step("injected");
        ctx.runConsole({ action: null, policyNote: null, diagnosisNote: null });
        ctx.setServiceMetrics(TARGET, {
          cpu: 68,
          memory: 71,
          latencyP95: 244,
          errorRate: 1.1,
          throughput: 656,
        });
        ctx.pushEvent("incident", "Fault injected — unclassified anomaly", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("WARN", TARGET, "Irregular behaviour across multiple signals");
      },
    },
    {
      atMs: 4000,
      label: "drift",
      run: (ctx) => {
        // Deliberately below every static threshold: cpu never reaches 85.
        ctx.setServiceMetrics(TARGET, {
          cpu: 79,
          memory: 77,
          latencyP95: 338,
          errorRate: 1.9,
          throughput: 604,
        });
        ctx.setServiceStatus(TARGET, "degraded");
        ctx.pushEvent("telemetry", "orders-service degraded — mixed signal drift", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("WARN", TARGET, "Throughput falling while CPU and latency climb");
      },
    },
    {
      atMs: 7500,
      label: "ml-detected",
      run: (ctx) => {
        ctx.setDetector("ml", { fired: true, firedAt: ctx.now(), value: 0.79 });
        ctx.setAnomaly({
          score: 0.79,
          baseline: "abnormal",
          serviceId: TARGET,
          detectedAt: ctx.now(),
          note: "Signal combination is outside the learned baseline envelope.",
          contributions: [
            { feature: "Throughput", weight: 31 },
            { feature: "P95 latency", weight: 27 },
            { feature: "CPU", weight: 22 },
            { feature: "Error rate", weight: 12 },
            { feature: "Memory", weight: 8 },
          ],
        });
        ctx.step("detected");
        ctx.setIsland("anomaly");

        incidentId = ctx.openIncident({
          title: "Unclassified anomaly",
          serviceId: TARGET,
          severity: "warning",
          rootCause: "Unknown — no signature matched",
          action: "Escalate to operator",
          anomalyScore: 0.79,
          before: ctx.snapshot(TARGET),
        });

        ctx.pushTerminal("anomaly detected", "warn");
        ctx.pushEvent("incident", `${incidentId} opened — orders-service anomaly`, {
          severity: "crit",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 8500,
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
      },
    },
    {
      atMs: 12000,
      label: "no-signature",
      run: (ctx) => {
        const diagnosis = {
          signature: "UNKNOWN",
          match: MATCH,
          faultType: "unknown",
          summary: "No known fault signature matched the deviation.",
        };
        ctx.setDiagnosis(diagnosis);
        // No policyId: nothing matched, which is exactly why this escalates.
        if (incidentId) ctx.updateIncident(incidentId, { diagnosis });
        ctx.pushTerminal("classification: unknown", "warn");
        ctx.pushTerminal(`signature match: ${MATCH.toFixed(2)}`, "warn");
        ctx.runConsole({
          diagnosisNote: `unknown · signature match ${Math.round(MATCH * 100)}% (below ${Math.round(
            POLICY_FLOOR * 100,
          )}% floor)`,
        });
        if (incidentId) {
          ctx.completeStage(
            incidentId,
            "analyzed",
            `Signature match ${Math.round(MATCH * 100)}% — no known fault.`,
          );
          ctx.startStage(incidentId, "policy_check");
        }

        ctx.step("policy_check");
        ctx.pushTerminal("evaluating remediation policy", "command");
      },
    },
    {
      atMs: 14500,
      label: "escalated",
      run: (ctx) => {
        ctx.runConsole({
          policyNote: "No safe policy — manual approval required",
          action: null,
        });
        ctx.pushTerminal("no matching policy — manual approval required", "error");
        ctx.pushTerminal("ESCALATED — awaiting operator approval", "error");
        ctx.step("escalated");
        ctx.setIsland("escalated");
        if (incidentId) {
          ctx.failStage(
            incidentId,
            "policy_check",
            "No safe policy — manual approval required.",
          );
          ctx.failStage(incidentId, "escalated", "Awaiting operator approval.");
          ctx.updateIncident(incidentId, { status: "escalated", auto: false });
        }
        ctx.pushEvent("incident", "Escalated to operator — no safe automatic action", {
          severity: "crit",
          serviceId: TARGET,
        });
        ctx.log("ERROR", TARGET, "Escalated: no remediation policy matched");
        ctx.notify(
          "warning",
          "Escalated to operator",
          "No safe automatic action for orders-service — manual approval required.",
        );
      },
    },
    {
      atMs: 20000,
      label: "settling",
      run: (ctx) => {
        // No remediation ran. The signals fade on their own, as unexplained
        // transients do — the incident stays escalated regardless.
        ctx.setServiceTarget(TARGET, {
          cpu: 64,
          memory: 69,
          latencyP95: 232,
          errorRate: 1.0,
          throughput: 682,
        });
        ctx.pushEvent("telemetry", "orders-service signals easing — no action taken", {
          severity: "info",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 27000,
      label: "normalised",
      run: (ctx) => {
        ctx.resetServiceTarget(TARGET);
        ctx.setServiceStatus(TARGET, "healthy");
        ctx.setAnomaly({
          score: 0.21,
          baseline: "elevated",
          serviceId: TARGET,
          note: "Signals normalised, but the incident remains unexplained.",
        });
        ctx.setDetector("ml", { fired: false, firedAt: null, value: 0.21 });
        ctx.pushEvent("health", "orders-service back within baseline", {
          severity: "ok",
          serviceId: TARGET,
        });
      },
    },
    {
      atMs: 33000,
      label: "awaiting",
      run: (ctx) => {
        ctx.pushEvent("info", "Incident still escalated — awaiting operator review", {
          severity: "warn",
          serviceId: TARGET,
        });
        ctx.log("WARN", TARGET, "Escalated incident open; awaiting operator review");
      },
    },
  ],
};
