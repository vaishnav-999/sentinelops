"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { api } from "@/lib/api";
import { engine } from "@/lib/simulation/engine";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { CHAOS_FAULTS, type FaultSeverity } from "@/lib/mock-data/faults";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TONE_BADGE, type Tone } from "@/lib/tone";

const SEVERITY_TONE: Record<FaultSeverity, Tone> = {
  Medium: "warn",
  High: "warn",
  Critical: "crit",
};

/**
 * The six injectable faults. Every card routes through
 * `api.injectChaos` → `engine.runScenario`, the same entry point the global
 * hotkeys use, so there is exactly one way to start a run.
 */
export function FaultGrid() {
  const activeScenario = useSentinelStore((s) => s.activeScenario);
  const running = activeScenario !== null;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {CHAOS_FAULTS.map((fault) => {
        const isActive = activeScenario === fault.scenarioId;
        return (
          <Panel key={fault.scenarioId} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-text">{fault.name}</h3>
              <Badge variant={TONE_BADGE[SEVERITY_TONE[fault.severity]]}>
                {fault.severity}
              </Badge>
            </div>

            <p className="mt-1 text-sm text-text-2">{fault.description}</p>

            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <dt className="label">Target service</dt>
                <dd className={cn("mt-1 truncate text-sm text-text", numeric)}>
                  {fault.target}
                </dd>
              </div>
              <div>
                <dt className="label">Expected outcome</dt>
                <dd
                  className={cn(
                    "mt-1 text-sm",
                    fault.expected === "Auto-heal" ? "text-ok-text" : "text-crit-text",
                  )}
                >
                  {fault.expected}
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className={cn("text-xs text-muted", numeric)}>
                ~{fault.durationSec}s
              </span>
              <Button
                size="sm"
                disabled={running}
                onClick={() => void api.injectChaos({ scenario: fault.scenarioId })}
              >
                {isActive ? "Running…" : fault.action}
              </Button>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

/** Always enabled: cancels any run, clears timers and restores the seed state. */
export function ResetDemoButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => engine.reset()}>
      Reset Demo
    </Button>
  );
}
