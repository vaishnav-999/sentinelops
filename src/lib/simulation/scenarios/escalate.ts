import type { ScenarioContext } from "../scenario-runner";

/**
 * Hand a run to an operator.
 *
 * Two things end a run this way even though a safe policy existed: a guardrail
 * refused the action, or the platform is in dry-run and may only recommend it.
 * Both land here so the incident, the run console, the terminal and the island
 * always agree on what happened — and so no run can quietly end "resolved"
 * after nothing was actually executed.
 */
export interface EscalateInput {
  incidentId: string | null;
  target: string;
  /** Run-console policy line explaining why nothing ran. */
  policyNote: string;
  /** Short label recorded on the incident, e.g. "Recommended — awaiting approval". */
  outcomeLabel: string;
  /**
   * Detail for a FAILED policy-check stage, or null when the policy check
   * itself succeeded (dry run) and only the execution was withheld.
   */
  policyStageDetail: string | null;
  /** Toast description. */
  toast: string;
}

export function escalate(ctx: ScenarioContext, input: EscalateInput): void {
  ctx.runConsole({ policyNote: input.policyNote, action: null });
  ctx.pushTerminal("ESCALATED — awaiting operator approval", "error");
  ctx.step("escalated");
  ctx.setIsland("escalated");

  if (input.incidentId) {
    if (input.policyStageDetail !== null) {
      ctx.failStage(input.incidentId, "policy_check", input.policyStageDetail);
    }
    ctx.failStage(input.incidentId, "escalated", "Awaiting operator approval.");
    ctx.updateIncident(input.incidentId, {
      status: "escalated",
      auto: false,
      outcomeLabel: input.outcomeLabel,
    });
  }

  ctx.pushEvent("incident", `Escalated to operator — ${input.outcomeLabel}`, {
    severity: "crit",
    serviceId: input.target,
  });
  ctx.log("ERROR", input.target, `Escalated: ${input.outcomeLabel}`);
  ctx.notify("warning", "Escalated to operator", input.toast);
}
