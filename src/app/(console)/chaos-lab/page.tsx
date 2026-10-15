import type { Metadata } from "next";
import { TriangleAlertIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { FaultGrid, ResetDemoButton } from "@/components/chaos/fault-grid";
import { RunConsole } from "@/components/chaos/run-console";
import { ExperimentRuns } from "@/components/chaos/experiment-runs";
import { IS_LIVE } from "@/lib/api/mode";

export const metadata: Metadata = {
  title: "Chaos Lab — SentinelOps",
};

/**
 * Chaos Lab (SPEC §13): inject a controlled failure, then watch SentinelOps
 * detect, diagnose, remediate and verify it — live, on this page and on every
 * other one, because the engine lives in the provider rather than here.
 */
export default function ChaosLabPage() {
  return (
    <>
      <PageHeader
        title="Chaos Lab"
        description={
          IS_LIVE
            ? "Inject real, reversible failures into the local demo containers."
            : "Safely inject controlled failures into the demo environment."
        }
      />

      <div className="mb-3 flex items-center justify-between gap-4 rounded-lg border border-warn/40 bg-warn-badge px-4 py-2.5">
        <div className="flex items-center gap-2">
          <TriangleAlertIcon
            className="size-4 shrink-0 text-warn-text"
            strokeWidth={1.75}
          />
          <span className="text-sm font-medium text-warn-text">
            {IS_LIVE ? "LOCAL DOCKER STACK ONLY" : "DEMO ENVIRONMENT ONLY"}
          </span>
          <span className="hidden text-sm text-text-2 sm:inline">
            {IS_LIVE
              ? "Faults are real and hit the demo containers in docker-compose.live.yml."
              : "Faults are simulated. No real infrastructure is touched."}
          </span>
        </div>
        <ResetDemoButton />
      </div>

      <div className="flex flex-col gap-3">
        <FaultGrid />
        <RunConsole />
        <ExperimentRuns />
      </div>
    </>
  );
}
