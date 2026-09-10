"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { autonomyStatus } from "@/lib/remediation";
import { TONE_BADGE, TONE_DOT, TONE_TEXT } from "@/lib/tone";

/**
 * The autonomy status strip (SPEC §12), entirely derived from the store: how
 * the engine is configured right now, what it has actually done today, and the
 * two guardrails standing between it and a bad decision.
 *
 * The success rate is a real quotient over recorded executions and is labelled
 * Simulated; before anything has run it reads "—" rather than inventing 98%.
 */
export function AutonomyStrip() {
  const settings = useSentinelStore((s) => s.settings);
  const executions = useSentinelStore((s) => s.executions);
  const incidents = useSentinelStore((s) => s.incidents);
  const policies = useSentinelStore((s) => s.policies);
  const now = useSentinelStore((s) => s.cluster.t);
  const updateSettings = useSentinelStore((s) => s.updateSettings);

  const status = autonomyStatus(settings, executions, incidents, policies, now);

  return (
    <Panel>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="truncate text-xs font-medium text-text-2">
          Autonomy status
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          <Label
            htmlFor="dry-run"
            className="text-xs font-normal text-text-2 select-none"
          >
            Dry run
          </Label>
          <Switch
            id="dry-run"
            checked={settings.dryRun}
            onCheckedChange={(checked) => updateSettings({ dryRun: checked })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
        <Cell label="Autonomy">
          <span className="flex items-center gap-2">
            <span className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} />
            <span className={cn("text-xl", TONE_TEXT[status.tone])}>
              {status.label}
            </span>
          </span>
          <Note>
            {settings.dryRun
              ? "Actions are recommended, never executed"
              : "Safe policies act without approval"}
          </Note>
        </Cell>

        <Cell label="Auto-heals today">
          <span className={cn("text-xl text-text", numeric)}>
            {status.autoHealsToday}
          </span>
          <Note>Resolved without an operator</Note>
        </Cell>

        <Cell label="Remediation success rate">
          {status.successRatePct === null ? (
            <span className="text-xl text-muted">—</span>
          ) : (
            <span className={cn("text-xl text-text", numeric)}>
              {status.successRatePct}
              <span className="text-base text-muted">%</span>
            </span>
          )}
          <div className="mt-1">
            <Badge variant="outline" className="font-normal">
              {status.successRatePct === null
                ? "No executions yet"
                : `Simulated · ${status.successSamples} executions`}
            </Badge>
          </div>
        </Cell>

        <Cell label="Unsafe actions executed">
          <span className={cn("text-xl", numeric, TONE_TEXT["ok"])}>
            {status.unsafeActions}
          </span>
          <Note>Restricted policies never run automatically</Note>
        </Cell>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <span className="label">Guardrails</span>
        {status.guardrails.map((g) => (
          <Badge key={g} variant={TONE_BADGE["brand"]} className="font-normal">
            {g}
          </Badge>
        ))}
      </div>
    </Panel>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border px-4 py-3 lg:border-r lg:last:border-r-0">
      <div className="label">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-xs text-muted">{children}</div>;
}
