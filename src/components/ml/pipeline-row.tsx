"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "cn";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { ScenarioPhase } from "@/lib/types";

/**
 * The product story as a row (SPEC §27): observe → detect → understand →
 * decide → remediate → verify. The active stage is derived from the live
 * scenario phase, so the row lights up in step with a chaos run instead of
 * being a static diagram.
 */

const STAGES = [
  {
    id: "features",
    title: "Telemetry features",
    detail: "6 signals · 1s scrape",
    phases: [] as ScenarioPhase[],
  },
  {
    id: "detector",
    title: "Detector",
    detail: "Isolation Forest → anomaly score",
    phases: ["injecting", "detected"] as ScenarioPhase[],
  },
  {
    id: "diagnoser",
    title: "Diagnoser",
    detail: "Fault signatures → signature match",
    phases: ["diagnosing"] as ScenarioPhase[],
  },
  {
    id: "policy",
    title: "Policy engine",
    detail: "Deterministic rules",
    phases: ["policy_check"] as ScenarioPhase[],
  },
  {
    id: "remediation",
    title: "Remediation",
    detail: "Guardrailed action",
    phases: ["remediating"] as ScenarioPhase[],
  },
  {
    id: "verification",
    title: "Verification",
    detail: "Health checks → resolve",
    phases: ["verifying", "resolved"] as ScenarioPhase[],
  },
] as const;

export function PipelineRow() {
  const phase = useSentinelStore((s) => s.scenarioPhase);

  return (
    <Panel>
      <PanelHeader
        title="Detection pipeline"
        actions={
          <span className="text-xs text-muted">
            The LLM never decides or executes remediation
          </span>
        }
      />
      <div className="flex flex-col gap-2 px-4 py-4 lg:flex-row lg:items-stretch">
        {STAGES.map((stage, i) => {
          const active = (stage.phases as readonly ScenarioPhase[]).includes(phase);
          return (
            <div key={stage.id} className="flex min-w-0 flex-1 items-center gap-2">
              <div
                className={cn(
                  "min-w-0 flex-1 rounded-md border px-3 py-2",
                  active
                    ? "border-ai bg-ai-badge"
                    : "border-border bg-transparent",
                )}
              >
                <div
                  className={cn(
                    "truncate text-sm",
                    active ? "text-ai-text" : "text-text",
                  )}
                >
                  {stage.title}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {stage.detail}
                </div>
              </div>
              {i < STAGES.length - 1 ? (
                <ChevronRight
                  className="hidden size-4 shrink-0 text-muted lg:block"
                  strokeWidth={1.75}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
