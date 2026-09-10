"use client";

import { AutonomyStrip } from "@/components/remediation/autonomy-strip";
import { PoliciesTable } from "@/components/remediation/policies-table";
import { ExecutionsPanel } from "@/components/remediation/executions-panel";

/** /auto-heal: status, the policies, and what they actually did (SPEC §12). */
export function AutoHealView() {
  return (
    <div className="flex flex-col gap-3">
      <AutonomyStrip />
      <PoliciesTable />
      <ExecutionsPanel />
    </div>
  );
}
