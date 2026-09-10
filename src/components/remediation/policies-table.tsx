"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
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
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { formatAgo } from "@/lib/metrics";
import { RISK_LABEL, RISK_TONE } from "@/lib/incidents";
import { MODE_LABEL, MODE_TONE, policyRows } from "@/lib/remediation";
import { TONE_BADGE } from "@/lib/tone";

/**
 * The remediation policy table (SPEC §12).
 *
 * "Last triggered" and "Executions" are read off the audit trail, so a policy
 * that has never fired says so instead of borrowing another policy's history.
 * Expanding a row shows the condition the Diagnoser's output is tested
 * against — the rule, not a paraphrase of it.
 */
export function PoliciesTable() {
  const policies = useSentinelStore((s) => s.policies);
  const executions = useSentinelStore((s) => s.executions);
  const now = useSentinelStore((s) => s.cluster.t);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = policyRows(policies, executions);
  const automatic = rows.filter((r) => r.policy.mode === "automatic").length;

  return (
    <Panel>
      <PanelHeader
        title="Remediation policies"
        actions={
          <span className={cn("text-xs text-muted", numeric)}>
            {automatic} of {rows.length} automatic
          </span>
        }
      />
      <Table>
        <TableHeader>
          <TableRow className="border-border">
            <TableHead className="label h-9 pl-4">Policy id</TableHead>
            <TableHead className="label h-9">Trigger</TableHead>
            <TableHead className="label h-9">Action</TableHead>
            <TableHead className="label h-9">Mode</TableHead>
            <TableHead className="label h-9">Risk</TableHead>
            <TableHead className="label h-9">Last triggered</TableHead>
            <TableHead className="label h-9 pr-4 text-right">Executions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ policy, lastTriggeredAt, executions: count }) => {
            const open = expanded === policy.id;
            return (
              <Fragment key={policy.id}>
                <TableRow
                  className="cursor-pointer border-border"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : policy.id)}
                >
                  <TableCell className={cn("py-2 pl-4 text-text", numeric)}>
                    <span className="flex items-center gap-1.5">
                      <ChevronRight
                        className={cn(
                          "size-4 text-muted transition-transform duration-150 ease-out",
                          open && "rotate-90",
                        )}
                        strokeWidth={1.75}
                      />
                      {policy.id}
                    </span>
                  </TableCell>
                  <TableCell className="py-2 text-text">{policy.name}</TableCell>
                  <TableCell className="py-2 text-text-2">{policy.action}</TableCell>
                  <TableCell className="py-2">
                    <Badge variant={TONE_BADGE[MODE_TONE[policy.mode]]}>
                      {MODE_LABEL[policy.mode]}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge variant={TONE_BADGE[RISK_TONE[policy.risk]]}>
                      {RISK_LABEL[policy.risk]}
                    </Badge>
                  </TableCell>
                  <TableCell className={cn("py-2 text-text-2", numeric)}>
                    {lastTriggeredAt === null ? (
                      <span className="text-muted">Never</span>
                    ) : (
                      formatAgo(lastTriggeredAt, now)
                    )}
                  </TableCell>
                  <TableCell
                    className={cn("py-2 pr-4 text-right text-text-2", numeric)}
                  >
                    {count}
                  </TableCell>
                </TableRow>
                {open ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={7} className="bg-hover/40 px-4 py-3 whitespace-normal">
                      <div className="label">Conditions</div>
                      <div className={cn("mt-1 text-sm text-text", numeric)}>
                        {policy.conditions}
                      </div>
                      {policy.description ? (
                        <p className="mt-2 max-w-3xl text-sm text-text-2">
                          {policy.description}
                        </p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}
