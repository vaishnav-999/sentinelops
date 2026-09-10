"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { formatAgo } from "@/lib/metrics";
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  isLive,
  recentExecutions,
} from "@/lib/remediation";
import { TONE_BADGE, TONE_DOT } from "@/lib/tone";
import { ExecutionTerminal } from "@/components/remediation/execution-terminal";
import type { RemediationExecution } from "@/lib/types";

/** Keeps the list and the terminal the same height on a desktop screen. */
const PANEL_HEIGHT = "h-[420px]";

/**
 * Recent executions: the audit list on the left, the selected execution's
 * transcript on the right.
 *
 * Selection lives in the store rather than in local state so the engine can
 * open the newest run the moment a scenario starts — walking to /auto-heal
 * mid-run shows that run, not whatever was last clicked.
 */
export function ExecutionsPanel() {
  const executions = useSentinelStore((s) => s.executions);
  const selectedId = useSentinelStore((s) => s.selectedExecutionId);
  const select = useSentinelStore((s) => s.selectExecution);
  const now = useSentinelStore((s) => s.cluster.t);

  const rows = recentExecutions(executions);
  const selected = rows.find((e) => e.id === selectedId) ?? rows[0] ?? null;

  return (
    <Panel>
      <PanelHeader
        title="Recent executions"
        actions={
          <span className={cn("text-xs text-muted", numeric)}>
            {rows.length} recorded
          </span>
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* a) audit list */}
        <div
          className={cn(
            "overflow-y-auto border-b border-border lg:border-r lg:border-b-0",
            PANEL_HEIGHT,
          )}
        >
          {rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted">
              No remediation has run yet.
            </p>
          ) : (
            <ul>
              {rows.map((execution) => (
                <ExecutionRow
                  key={execution.id}
                  execution={execution}
                  now={now}
                  selected={selected?.id === execution.id}
                  onSelect={() => select(execution.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* b) transcript */}
        <div className={cn("flex min-w-0 flex-col", PANEL_HEIGHT)}>
          {selected === null ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">
              Select an execution to read its transcript.
            </div>
          ) : (
            <>
              <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
                <span className={cn("truncate text-xs text-text-2", numeric)}>
                  {selected.id} · {selected.serviceId}
                  {selected.action ? ` · ${selected.action}` : ""}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {selected.dryRun ? (
                    <Badge variant="warn">Dry run</Badge>
                  ) : null}
                  {isLive(selected) ? (
                    <span className="flex items-center gap-1.5 text-xs text-brand-text">
                      <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                      LIVE
                    </span>
                  ) : null}
                </div>
              </div>
              <ExecutionTerminal
                executionId={selected.id}
                lines={selected.lines}
                live={isLive(selected)}
              />
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ExecutionRow({
  execution,
  now,
  selected,
  onSelect,
}: {
  execution: RemediationExecution;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = OUTCOME_TONE[execution.outcome];

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full border-b border-border px-4 py-2.5 text-left transition-colors duration-150 ease-out",
          selected ? "bg-selected" : "hover:bg-hover",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm text-text", numeric)}>
            {execution.id}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {execution.dryRun ? (
              <span className="text-xs text-warn-text">dry run</span>
            ) : null}
            <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
            <Badge variant={TONE_BADGE[tone]}>
              {OUTCOME_LABEL[execution.outcome]}
            </Badge>
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-xs text-text-2">
            {execution.serviceId}
            {execution.action ? ` · ${execution.action}` : " · evaluating"}
          </span>
          <span className={cn("shrink-0 text-xs text-muted", numeric)}>
            {formatAgo(execution.startedAt, now)}
          </span>
        </div>
      </button>
    </li>
  );
}
