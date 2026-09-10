"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { TONE_BADGE } from "@/lib/tone";
import type { SentinelSettings } from "@/lib/types";

/**
 * /settings — the operator's control surface (SPEC §26).
 *
 * Two switches are load-bearing and wired straight into the store the engine
 * reads: `autoRemediation` (the master safety switch) and `dryRun` (shared
 * with the Auto-Heal page — one field, two places to flip it). The rest are
 * frontend-only preferences; they toggle and persist for the session, and the
 * page says which are not connected to anything yet.
 */

interface Integration {
  name: string;
  detail: string;
  status: "Not connected" | "Not configured";
}

const INTEGRATIONS: Integration[] = [
  { name: "Docker", detail: "Container runtime · docker.sock", status: "Not connected" },
  { name: "PostgreSQL", detail: "Incident and metric persistence", status: "Not connected" },
  { name: "Slack", detail: "Incident notifications", status: "Not connected" },
  { name: "PagerDuty", detail: "On-call escalation", status: "Not connected" },
  { name: "Gemini", detail: "Incident report generation", status: "Not configured" },
];

export function SettingsView() {
  const settings = useSentinelStore((s) => s.settings);
  const update = useSentinelStore((s) => s.updateSettings);

  const set = (patch: Partial<SentinelSettings>) => update(patch);

  return (
    <div className="flex flex-col gap-3">
      {/* The one setting that changes what the platform is allowed to do. */}
      <Panel>
        <PanelHeader
          title="Auto-Heal"
          actions={
            <Badge
              variant={settings.autoRemediation ? TONE_BADGE.ok : TONE_BADGE.warn}
              className="font-normal"
            >
              {settings.autoRemediation ? "Autonomous" : "Approval required"}
            </Badge>
          }
        />
        <div className="flex items-start justify-between gap-6 px-4 py-4">
          <div className="min-w-0">
            <Label
              htmlFor="auto-remediation"
              className="text-base font-medium text-text"
            >
              Allow automatic remediation
            </Label>
            <p className="mt-1 text-sm text-text-2">
              Only policies classified as safe may execute without operator
              approval.
            </p>
            <p className="mt-1 text-xs text-muted">
              {settings.autoRemediation
                ? "Matching incidents are remediated automatically, inside the guardrails below."
                : "Every incident stops at the policy check and escalates as “Awaiting operator approval”."}
            </p>
          </div>
          <Switch
            id="auto-remediation"
            checked={settings.autoRemediation}
            onCheckedChange={(v) => set({ autoRemediation: v })}
          />
        </div>

        <Row
          id="dry-run"
          label="Dry run"
          description="Actions are simulated and recorded, never executed. Shared with the Auto-Heal page."
          checked={settings.dryRun}
          onChange={(v) => set({ dryRun: v })}
        />
        <Row
          id="verify-after"
          label="Verify after remediation"
          description="Run post-action health checks before an incident is closed."
          checked={settings.verifyAfterRemediation}
          onChange={(v) => set({ verifyAfterRemediation: v })}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Monitoring" />
          <ReadOnlyRow
            label="Telemetry scrape interval"
            value={`${settings.scrapeIntervalSec}s`}
          />
          <Row
            id="anomaly-scan"
            label="Score every telemetry batch"
            description="Run the detector on each scrape rather than on a slower schedule."
            checked={settings.anomalyScan}
            onChange={(v) => set({ anomalyScan: v })}
          />
          <ReadOnlyRow label="Monitored services" value="6" />
          <ReadOnlyRow label="Retention" value="In-memory (demo)" />
        </Panel>

        <Panel>
          <PanelHeader title="Notifications" />
          <Row
            id="notify-toasts"
            label="Show toast notifications"
            description="Platform events surface as toasts in the console."
            checked={settings.notifyToasts}
            onChange={(v) => set({ notifyToasts: v })}
          />
          <Row
            id="notify-critical"
            label="Critical and escalations only"
            description="Suppress informational toasts during a run."
            checked={settings.notifyCriticalOnly}
            onChange={(v) => set({ notifyCriticalOnly: v })}
            disabled={!settings.notifyToasts}
          />
          <ReadOnlyRow label="Email digest" value="Not configured" />
        </Panel>

        <Panel>
          <PanelHeader title="Safety policies" />
          <ReadOnlyRow
            label="Restart limit"
            value={`${settings.restartLimit} per service`}
          />
          <ReadOnlyRow
            label="Guardrail window"
            value={`${Math.round(settings.guardrailWindowSec / 60)} min`}
          />
          <ReadOnlyRow label="Cooldown" value={`${settings.cooldownSec}s`} />
          <Row
            id="block-restricted"
            label="Restricted policies always need an operator"
            description="Policies classified restricted are never executed automatically."
            checked={settings.blockRestrictedActions}
            onChange={(v) => set({ blockRestrictedActions: v })}
          />
        </Panel>

        <Panel>
          <PanelHeader
            title="Model configuration"
            actions={<span className="text-xs text-muted">Read-only in this build</span>}
          />
          <ReadOnlyRow label="Detector" value="Isolation Forest" />
          <ReadOnlyRow label="Model status" value="Simulated — training pending" />
          <ReadOnlyRow
            label="Baseline window"
            value={`${settings.baselineWindowHours}h`}
          />
          <ReadOnlyRow
            label="Signature-match floor"
            value={settings.decisionThreshold.toFixed(2)}
          />
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Integrations"
          actions={
            <span className="text-xs text-muted">
              Simulated backend — nothing is connected yet
            </span>
          }
        />
        <ul className="flex flex-col divide-y divide-border">
          {INTEGRATIONS.map((integration) => (
            <li
              key={integration.name}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-text">{integration.name}</div>
                <div className="truncate text-xs text-muted">
                  {integration.detail}
                </div>
              </div>
              <Badge variant={TONE_BADGE.muted} className="shrink-0 font-normal">
                {integration.status}
              </Badge>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Row({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-6 border-t border-border px-4 py-3",
        disabled && "opacity-60",
      )}
    >
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-normal text-text">
          {label}
        </Label>
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3 first:border-t-0">
      <span className="text-sm text-text">{label}</span>
      <span className={cn("shrink-0 text-sm text-text-2", numeric)}>{value}</span>
    </div>
  );
}
