"use client";

import { useState } from "react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { resetTrustLive } from "@/lib/live/live-connection";
import { formatAgo } from "@/lib/metrics";
import { TONE_BADGE, TONE_DOT } from "@/lib/tone";
import type { PolicyTrustRecord } from "@/lib/types";

const OUTCOME_LABEL: Record<NonNullable<PolicyTrustRecord["lastOutcome"]>, string> = {
  durable: "Fix held",
  relapsed: "Fault came back",
  verify_failed: "Verification failed",
  action_failed: "Action failed",
};

/**
 * Earned autonomy (live mode). Each policy acts on a service by itself only
 * while the evidence says its fixes hold there. A fix counts as durable when
 * the same fault stays away for the relapse window; a relapse or a failed
 * action counts against it. Below the floor the policy still diagnoses and
 * recommends, but an operator approves.
 */
export function TrustPanel() {
  const state = useSentinelStore((s) => s.policyTrust);
  const now = useSentinelStore((s) => s.cluster.t);
  const [busy, setBusy] = useState<string | null>(null);

  if (!state) return null;

  const restore = async (rec?: PolicyTrustRecord) => {
    const key = rec ? `${rec.policyId}:${rec.serviceId}` : "all";
    setBusy(key);
    try {
      await resetTrustLive(rec?.policyId, rec?.serviceId);
    } finally {
      setBusy(null);
    }
  };

  const demoted = state.records.filter((r) => !r.autonomous).length;
  const floorPct = Math.round(state.floor * 100);
  const windowMin = Math.round(state.relapseWindowSec / 60);

  return (
    <Panel>
      <PanelHeader
        title="Earned autonomy"
        actions={
          <>
            <span className={cn("text-xs text-muted", numeric)}>
              {demoted === 0 ? "All policies autonomous" : `${demoted} need approval`}
            </span>
            {state.records.length ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void restore()}
              >
                Reset all
              </Button>
            ) : null}
          </>
        }
      />
      <p className="border-b border-border px-4 py-3 text-sm text-text-2">
        A policy keeps acting on its own only while its fixes last. A fix counts as
        durable if the same fault stays away for {windowMin} minutes. A relapse or a
        failed action lowers trust, and below {floorPct}% the policy asks an operator
        first.
      </p>
      {state.records.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">
          No remediation evidence yet. New policies start at{" "}
          <span className={numeric}>{Math.round(state.initial * 100)}%</span> trust.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="border-border">
              <TableHead className="label h-9 pl-4">Policy</TableHead>
              <TableHead className="label h-9">Service</TableHead>
              <TableHead className="label h-9">Trust</TableHead>
              <TableHead className="label h-9">Evidence</TableHead>
              <TableHead className="label h-9">Last outcome</TableHead>
              <TableHead className="label h-9">Status</TableHead>
              <TableHead className="label h-9 pr-4 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.records.map((rec) => {
              const key = `${rec.policyId}:${rec.serviceId}`;
              const pct = Math.round(rec.trust * 100);
              return (
                <TableRow key={key} className="border-border">
                  <TableCell className={cn("py-2 pl-4 text-text", numeric)}>
                    {rec.policyId}
                  </TableCell>
                  <TableCell className={cn("py-2 text-text-2", numeric)}>
                    {rec.serviceId}
                  </TableCell>
                  <TableCell className="py-2">
                    <TrustBar value={rec.trust} floor={state.floor} />
                    <span className={cn("ml-2 text-sm text-text", numeric)}>{pct}%</span>
                  </TableCell>
                  <TableCell className={cn("py-2 text-text-2", numeric)}>
                    {rec.successes} held · {rec.failures - rec.relapses} failed ·{" "}
                    {rec.relapses} relapsed
                  </TableCell>
                  <TableCell className="py-2 text-text-2">
                    {rec.pendingSince !== null ? (
                      <span className={numeric}>
                        Watching fix · {formatAgo(rec.pendingSince, now)}
                      </span>
                    ) : rec.lastOutcome ? (
                      OUTCOME_LABEL[rec.lastOutcome]
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge variant={TONE_BADGE[rec.autonomous ? "ok" : "warn"]}>
                      {rec.autonomous ? "Autonomous" : "Needs approval"}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-right">
                    {rec.autonomous ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void restore(rec)}
                      >
                        Restore autonomy
                      </Button>
                    )}
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

function TrustBar({ value, floor }: { value: number; floor: number }) {
  const ok = value >= floor;
  return (
    <span className="relative inline-block h-1.5 w-20 rounded-full bg-hover align-middle">
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", TONE_DOT[ok ? "ok" : "warn"])}
        style={{ width: `${Math.round(value * 100)}%` }}
      />
      <span
        className="absolute -inset-y-0.5 w-px bg-text-2"
        style={{ left: `${Math.round(floor * 100)}%` }}
        aria-hidden
      />
    </span>
  );
}
