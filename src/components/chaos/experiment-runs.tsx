"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { ExperimentOutcome, ExperimentRun } from "@/lib/types";
import { formatClockTime } from "@/lib/metrics";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const OUTCOME_COPY: Record<
  ExperimentOutcome,
  { label: string; variant: "ok" | "crit" | "brand" | "outline" }
> = {
  running: { label: "Running", variant: "brand" },
  auto_healed: { label: "Auto-healed", variant: "ok" },
  escalated: { label: "Escalated", variant: "crit" },
  cancelled: { label: "Cancelled", variant: "outline" },
  failed: { label: "Failed", variant: "crit" },
};

/** Seconds between injection and a recorded timestamp, or "—". */
function delta(run: ExperimentRun, at: number | null): string {
  if (at === null) return "—";
  return (Math.round((at - run.injectedAt) / 100) / 10).toFixed(1);
}

/**
 * Recorded chaos experiments (SPEC §36) — the research artefact of the demo.
 * Shaped for a future `POST /api/experiments`, and kept across Reset Demo so a
 * session's runs accumulate.
 */
export function ExperimentRuns() {
  const runs = useSentinelStore((s) => s.experimentRuns);
  const rows = [...runs].reverse();

  return (
    <Panel>
      <PanelHeader
        title="Experiment runs"
        actions={<Badge variant="outline">Simulated runs</Badge>}
      />
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">
          No experiments recorded yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run id</TableHead>
              <TableHead>Fault</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Injected at</TableHead>
              <TableHead className="text-right">Threshold detected (s)</TableHead>
              <TableHead className="text-right">ML detected (s)</TableHead>
              <TableHead className="text-right">Remediated (s)</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((run) => {
              const outcome = OUTCOME_COPY[run.outcome];
              return (
                <TableRow key={run.id}>
                  <TableCell className={numeric}>{run.id}</TableCell>
                  <TableCell className="text-text-2">{run.faultType}</TableCell>
                  <TableCell className={cn("text-text-2", numeric)}>
                    {run.target}
                  </TableCell>
                  <TableCell className={cn("text-text-2", numeric)}>
                    {formatClockTime(run.injectedAt)}
                  </TableCell>
                  <TableCell className={cn("text-right", numeric)}>
                    {delta(run, run.thresholdDetectedAt)}
                  </TableCell>
                  <TableCell className={cn("text-right", numeric)}>
                    {delta(run, run.mlDetectedAt)}
                  </TableCell>
                  <TableCell className={cn("text-right", numeric)}>
                    {delta(run, run.remediatedAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={outcome.variant}>{outcome.label}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
