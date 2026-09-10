"use client";

import { Fragment, type ReactNode } from "react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { AiIncidentReport } from "@/components/incidents/ai-incident-report";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import {
  METRIC_META,
  formatClockTime,
  formatDurationMs,
  formatMetricValue,
} from "@/lib/metrics";
import { TONE_BADGE, TONE_DOT, TONE_TEXT } from "@/lib/tone";
import {
  COMPARE_METRICS,
  INCIDENT_SEVERITY_TONE,
  RISK_LABEL,
  RISK_TONE,
  SEVERITY_LABEL,
  STAGE_LABEL,
  STAGE_STATUS_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  auditLog,
  isActive,
  lifecycleRows,
  observation,
  policyFor,
  type CompareMetric,
} from "@/lib/incidents";
import type { Incident, RemediationPolicy, ServiceMetrics } from "@/lib/types";

/**
 * The incident story, end to end (SPEC 11): what was seen, what it was matched
 * against, which policy allowed the action, what changed, and every automated
 * step that was taken. The incident is read from the store by id, so a live
 * incident keeps advancing through its lifecycle while the sheet is open.
 */
export function IncidentDetailSheet({
  incidentId,
  onClose,
}: {
  incidentId: string | null;
  onClose: () => void;
}) {
  const incident = useSentinelStore((s) =>
    incidentId ? s.incidents.find((x) => x.id === incidentId) : undefined,
  );
  const service = useSentinelStore((s) =>
    incident ? s.services.find((x) => x.id === incident.serviceId) : undefined,
  );
  const policies = useSentinelStore((s) => s.policies);

  return (
    <Sheet
      open={incidentId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full data-[side=right]:sm:max-w-[720px]"
      >
        {incident ? (
          <Body
            incident={incident}
            serviceName={service?.name ?? incident.serviceId}
            baseline={service?.baseline}
            policy={policyFor(incident, policies)}
          />
        ) : (
          <div className="px-4 py-10 text-center text-sm text-muted">
            That incident is no longer in the timeline.
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Body({
  incident,
  serviceName,
  baseline,
  policy,
}: {
  incident: Incident;
  serviceName: string;
  baseline: ServiceMetrics | undefined;
  policy: RemediationPolicy | undefined;
}) {
  const severityTone = INCIDENT_SEVERITY_TONE[incident.severity];
  const statusTone = STATUS_TONE[incident.status];
  const rows = lifecycleRows(incident);
  const audit = auditLog(incident, policy);
  const observed = observation(incident, baseline);
  const live = isActive(incident);

  return (
    <>
      {/* 1. Header */}
      <SheetHeader className="border-b border-border pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-xs text-muted", numeric)}>{incident.id}</span>
          <SheetTitle>{incident.title}</SheetTitle>
          <Badge variant={TONE_BADGE[severityTone]}>
            {SEVERITY_LABEL[incident.severity]}
          </Badge>
          <Badge variant={TONE_BADGE[statusTone]}>
            {STATUS_LABEL[incident.status]}
          </Badge>
          {/* Why it ended this way, when "escalated" alone does not say it:
              a dry-run recommendation and a guardrail refusal look identical
              in the status column but mean very different things. */}
          {incident.outcomeLabel ? (
            <Badge variant="outline" className="font-normal">
              {incident.outcomeLabel}
            </Badge>
          ) : null}
        </div>
        <SheetDescription className={numeric}>
          {serviceName} · {incident.serviceId} · detected{" "}
          {formatClockTime(incident.detectedAt)}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* 2. Lifecycle */}
        <Section title="Lifecycle">
          <ol className="flex flex-col">
            {rows.map((row) => {
              const tone = STAGE_STATUS_TONE[row.status];
              const reached = row.at !== undefined;
              return (
                <li
                  key={row.stage}
                  className="flex items-baseline gap-3 border-b border-border py-1.5 last:border-b-0"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      TONE_DOT[tone],
                      row.status === "active" && "animate-pulse",
                    )}
                  />
                  <span
                    className={cn(
                      "w-28 shrink-0 text-sm",
                      reached ? TONE_TEXT[tone] : "text-muted",
                    )}
                  >
                    {STAGE_LABEL[row.stage]}
                  </span>
                  <span className={cn("w-20 shrink-0 text-sm text-text-2", numeric)}>
                    {reached ? formatClockTime(row.at as number) : "—"}
                  </span>
                  <span className={cn("w-16 shrink-0 text-xs text-muted", numeric)}>
                    {row.durationMs === null ? "" : formatDurationMs(row.durationMs)}
                  </span>
                  <span className="min-w-0 flex-1 text-xs text-muted">
                    {row.detail ?? ""}
                  </span>
                </li>
              );
            })}
          </ol>
        </Section>

        {/* 3. Evidence */}
        <Section title="Evidence">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <Field
              label="Anomaly score"
              value={incident.anomalyScore?.toFixed(2) ?? "—"}
              mono
            />
            <Field
              label="Signature match"
              value={
                incident.diagnosis
                  ? `${incident.diagnosis.signature} · ${Math.round(
                      incident.diagnosis.match * 100,
                    )}%`
                  : "—"
              }
              mono
            />
            <Field
              label="Observed"
              value={
                observed
                  ? `${METRIC_META[observed.metric].label} ${formatValue(
                      observed.from,
                      observed.metric,
                    )} → ${formatValue(observed.to, observed.metric)} · demo time compressed`
                  : "—"
              }
              wide
            />
            <Field
              label="Likely cause"
              value={incident.diagnosis?.summary ?? incident.rootCause}
              wide
            />
            <Field label="Recommended action" value={incident.action} />
            <div className="min-w-0">
              <dt className="label">Safety policy</dt>
              <dd className="mt-1 flex items-center gap-2">
                <span className={cn("text-sm text-text", numeric)}>
                  {policy?.id ?? "—"}
                </span>
                {policy ? (
                  <Badge variant={TONE_BADGE[RISK_TONE[policy.risk]]}>
                    {RISK_LABEL[policy.risk]}
                  </Badge>
                ) : null}
              </dd>
            </div>
          </dl>
        </Section>

        {/* 4. Before vs after */}
        <Section title="Before vs after">
          <div className="grid grid-cols-4 gap-x-4 gap-y-2">
            <span className="label">Metric</span>
            <span className="label text-right">Before</span>
            <span className="label text-right">After</span>
            <span className="label text-right">Change</span>
            {COMPARE_METRICS.map((metric) => {
              const before = incident.before?.[metric];
              const after = incident.after?.[metric];
              const change =
                before !== undefined && after !== undefined ? after - before : null;
              return (
                <Fragment key={metric}>
                  <span className="text-sm text-text-2">
                    {METRIC_META[metric].label}
                  </span>
                  <span className={cn("text-right text-sm text-text", numeric)}>
                    {before === undefined ? "—" : formatValue(before, metric)}
                  </span>
                  <span className={cn("text-right text-sm text-text", numeric)}>
                    {after === undefined ? "—" : formatValue(after, metric)}
                  </span>
                  <span
                    className={cn(
                      "text-right text-sm",
                      numeric,
                      change === null
                        ? "text-muted"
                        : change < 0
                          ? "text-ok-text"
                          : "text-warn-text",
                    )}
                  >
                    {change === null
                      ? "—"
                      : `${change > 0 ? "+" : ""}${formatValue(change, metric)}`}
                  </span>
                </Fragment>
              );
            })}
          </div>
        </Section>

        {/* 5. Recovery time */}
        <Section title="Recovery time">
          <div className={cn("text-2xl", numeric)}>
            {incident.recoverySec === undefined ? (
              <span className="text-muted">{live ? "In progress" : "—"}</span>
            ) : (
              <>
                <span className="text-text">{incident.recoverySec}</span>
                <span className="text-base text-muted"> seconds</span>
              </>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            Detected to resolved, from this run. Simulated telemetry.
          </p>
        </Section>

        {/* 6. Audit log */}
        <Section title="Audit log">
          {audit.length === 0 ? (
            <p className="text-sm text-muted">No automated actions recorded yet.</p>
          ) : (
            <ol className="flex flex-col">
              {audit.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border py-1.5 last:border-b-0"
                >
                  <span className={cn("text-xs text-muted", numeric)}>
                    {formatClockTime(entry.at)}
                  </span>
                  <span className={cn("text-xs text-text-2", numeric)}>
                    {entry.actor}
                  </span>
                  <span className={cn("text-sm text-text", numeric)}>
                    {entry.action}
                  </span>
                  <span className={cn("text-xs text-muted", numeric)}>
                    {entry.policy ?? "—"}
                  </span>
                  <span className={cn("text-xs", TONE_TEXT[entry.tone])}>
                    {entry.result}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* 7. Gemini narrative (later phase) */}
        <AiIncidentReport incident={incident} />
      </div>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="label mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <dt className="label">{label}</dt>
      <dd className={cn("mt-1 text-sm text-text", mono && numeric)}>{value}</dd>
    </div>
  );
}

function formatValue(value: number, metric: CompareMetric): string {
  return `${formatMetricValue(value, metric)}${METRIC_META[metric].unit}`;
}
