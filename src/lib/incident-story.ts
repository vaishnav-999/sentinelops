import type { Incident } from "@/lib/types";

/**
 * The incident in plain sentences, for readers who do not know what an
 * anomaly score or a signature match is. Every clause is derived from the
 * recorded incident; nothing here is inferred beyond what the pipeline logged.
 */
export function plainSummary(incident: Incident, serviceName: string): string[] {
  const out: string[] = [];
  const trigger = incident.stages.find((s) => s.stage === "detected")?.detail ?? "";
  const byRule = trigger.startsWith("Static rule");
  out.push(
    `${serviceName} started behaving abnormally. ${
      byRule ? "A fixed alert rule" : "The anomaly detector"
    } noticed it.`,
  );

  if (incident.recurrenceOf) {
    out.push(
      `This is the same fault coming back ${incident.relapseAfterSec ?? "?"} s after ${incident.recurrenceOf} was fixed, so that fix did not last.`,
    );
  }

  const diag = incident.diagnosis;
  if (diag) {
    const pct = Math.round(diag.match * 100);
    out.push(
      diag.faultType === "unknown"
        ? `The pattern did not match any known fault well enough (best match ${pct}%), so nothing was changed automatically.`
        : `It matches the pattern of a ${incident.title.toLowerCase()} (${pct}% signature match).`,
    );
  }

  const action = incident.action.toLowerCase();
  if (incident.status === "resolved") {
    out.push(
      incident.auto
        ? `SentinelOps applied "${action}" by itself and checked that the service was healthy again${
            incident.recoverySec !== undefined ? `, ${incident.recoverySec} s after detection` : ""
          }.`
        : `An operator approved "${action}" and the service recovered.`,
    );
  } else if (incident.status === "escalated") {
    out.push(
      `SentinelOps did not act on its own and handed the incident to an operator${
        incident.outcomeLabel ? ` (${incident.outcomeLabel.replace(/ — escalated to operator$/, "").toLowerCase()})` : ""
      }.`,
    );
  } else {
    out.push("SentinelOps is still working on it.");
  }

  if (incident.relapsedBy) {
    out.push(`The fault came back later (${incident.relapsedBy}), so this fix counted against the policy's trust.`);
  }

  const impact = incident.impact ?? [];
  if (impact.length) {
    const names = impact.map((x) => x.serviceId).join(", ");
    out.push(
      `${impact.length === 1 ? "1 other service" : `${impact.length} other services`} (${names}) degraded because of this fault. They were not restarted, since the cause was here.`,
    );
  }
  return out;
}
