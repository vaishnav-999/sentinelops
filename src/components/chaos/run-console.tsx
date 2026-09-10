"use client";

import Link from "next/link";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { ChaosRunState, RunStepId } from "@/lib/types";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { METRIC_META, formatAxisValue, formatMetricValue } from "@/lib/metrics";
import type { MetricKey } from "@/lib/simulation/thresholds";

const STEP_LABEL: Record<RunStepId, string> = {
  injected: "Injected",
  detected: "Detected",
  analyzing: "Analyzing",
  policy_check: "Policy check",
  remediating: "Remediating",
  verifying: "Verifying",
  resolved: "Resolved",
  escalated: "Escalated",
};

const CHART_HEIGHT = 132;

/** Percent metrics read better pinned to a full scale than auto-zoomed. */
const FIXED_DOMAIN: Partial<Record<MetricKey, [number, number]>> = {
  cpu: [0, 100],
  memory: [0, 100],
};

function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/**
 * The Chaos Lab run console — one of the only two visually special surfaces in
 * the product. It shows what SentinelOps did and, just as importantly, when:
 * the phase stepper, the target metric against its threshold, the two
 * detectors side by side, and the result.
 *
 * It stays on screen after a run finishes; a new run or Reset Demo clears it.
 */
export function RunConsole() {
  const run = useSentinelStore((s) => s.chaosRun);
  const clock = useSentinelStore((s) => s.cluster.t);
  const histories = useSentinelStore((s) => s.histories);
  const detectors = useSentinelStore((s) => s.detectors);

  if (!run) {
    return (
      <Panel>
        <PanelHeader title="Run console" />
        <div className="px-4 py-10 text-center text-sm text-muted">
          No run yet. Inject a fault above to watch the full detect → diagnose →
          remediate → verify cycle.
        </div>
      </Panel>
    );
  }

  const metric = run.metric as MetricKey;
  const meta = METRIC_META[metric];
  const start = run.injectedAt ?? run.requestedAt;
  const end = run.finishedAt ?? clock;
  const elapsedMs = Math.max(0, end - start);

  const data = (histories[run.target] ?? [])
    .filter((s) => s.t >= start - 5000)
    .map((s) => ({ t: s.t, v: s[metric] }));

  const ml = detectors.find((d) => d.kind === "ml");
  const threshold = detectors.find((d) => d.kind === "threshold");

  return (
    <Panel>
      <PanelHeader
        title={`Run console — ${run.title}`}
        actions={
          <>
            <span className={cn("text-xs text-muted", numeric)}>{run.runId}</span>
            <Badge variant="outline">Demo time compressed</Badge>
          </>
        }
      />

      {/* a) countdown / injection banner */}
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        {run.countdown !== null ? (
          <div className="flex items-baseline gap-2">
            <span className={cn("text-2xl text-warn-text", numeric)}>
              {run.countdown}
            </span>
            <span className="text-sm text-text-2">Injecting fault…</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-text">Fault injected</span>
            <span className={cn("text-xs text-muted", numeric)}>{run.target}</span>
          </div>
        )}
        <div className="text-right">
          <div className="label">Elapsed</div>
          <div className={cn("mt-0.5 text-sm text-text", numeric)}>
            {seconds(elapsedMs)}s
          </div>
        </div>
      </div>

      {/* b) phase stepper */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-3">
        {run.steps.map((step, i) => {
          const done = step.at !== null && run.current !== step.id;
          const active = run.current === step.id;
          const failed = step.id === "escalated" && step.at !== null;
          return (
            <li key={step.id} className="flex items-center gap-2">
              {i > 0 ? <span className="text-xs text-muted">→</span> : null}
              <span
                className={cn(
                  "flex items-center gap-1.5 text-sm",
                  failed
                    ? "text-crit-text"
                    : active
                      ? "font-medium text-brand-text"
                      : done
                        ? "text-ok-text"
                        : "text-muted",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    failed
                      ? "bg-crit"
                      : active
                        ? "bg-brand animate-pulse"
                        : done
                          ? "bg-ok"
                          : "bg-muted",
                  )}
                />
                {STEP_LABEL[step.id]}
                {step.at !== null ? (
                  <span className={cn("text-xs text-muted", numeric)}>
                    +{seconds(step.at - start)}s
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
        {/* c) live chart of the target metric with its threshold line */}
        <div className="border-b border-border px-4 py-3 lg:border-b-0 lg:border-r">
          <div className="flex items-baseline justify-between gap-2">
            <span className="label">
              {meta.label} · {run.target}
            </span>
            <span className={cn("text-sm text-text", numeric)}>
              {data.length
                ? `${formatMetricValue(data[data.length - 1].v, metric)}${meta.unit}`
                : "—"}
            </span>
          </div>
          <div className="mt-2" style={{ height: CHART_HEIGHT }}>
            {data.length >= 2 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--border)"
                    strokeOpacity={0.6}
                  />
                  <XAxis dataKey="t" hide type="number" domain={["dataMin", "dataMax"]} />
                  <YAxis
                    domain={FIXED_DOMAIN[metric] ?? ["auto", "auto"]}
                    tickFormatter={(v: number) => formatAxisValue(v, metric)}
                    tick={{ fill: "var(--muted)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <ReferenceLine
                    y={run.threshold}
                    stroke="var(--warn)"
                    strokeDasharray="4 4"
                    strokeOpacity={0.8}
                    label={{
                      value: run.thresholdLabel,
                      position: "insideTopRight",
                      fill: "var(--warn-text)",
                      fontSize: 11,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="v"
                    stroke="var(--brand)"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted">
                Waiting for telemetry…
              </div>
            )}
          </div>
        </div>

        {/* d) detector comparison */}
        <div className="px-4 py-3">
          <span className="label">Detector comparison</span>
          <dl className="mt-2 space-y-2">
            <DetectorRow
              name={`Threshold rule (${run.thresholdLabel})`}
              firedSec={run.thresholdDetectedSec}
              fired={threshold?.fired ?? false}
            />
            <DetectorRow
              name="Anomaly detector (Isolation Forest)"
              firedSec={run.mlDetectedSec}
              fired={ml?.fired ?? false}
            />
          </dl>

          <div className="mt-3 space-y-1.5 border-t border-border pt-3">
            <Note label="Diagnosis" value={run.diagnosisNote} />
            <Note label="Policy" value={run.policyNote} />
            <Note
              label="Health checks"
              value={
                run.healthChecks.length
                  ? `${run.healthChecks.length} passed · ${run.healthChecks.join(" · ")}`
                  : null
              }
            />
          </div>
        </div>
      </div>

      {/* f) result */}
      <RunResult run={run} />
    </Panel>
  );
}

function DetectorRow({
  name,
  fired,
  firedSec,
}: {
  name: string;
  fired: boolean;
  firedSec: number | null;
}) {
  const showFired = firedSec !== null;
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="min-w-0 truncate text-sm text-text-2">{name}</dt>
      <dd
        className={cn(
          "shrink-0 text-sm",
          showFired ? "text-warn-text" : "text-muted",
          numeric,
        )}
      >
        {showFired ? `Fired at +${firedSec}s` : fired ? "Fired" : "Not fired"}
      </dd>
    </div>
  );
}

function Note({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="label shrink-0">{label}</span>
      <span className="min-w-0 truncate text-sm text-text-2">{value ?? "—"}</span>
    </div>
  );
}

function RunResult({ run }: { run: ChaosRunState }) {
  if (run.outcome === "running") return null;

  const tone =
    run.outcome === "auto_healed"
      ? "text-ok-text"
      : run.outcome === "escalated"
        ? "text-crit-text"
        : "text-muted";
  const label =
    run.outcome === "auto_healed"
      ? "AUTO-HEALED"
      : run.outcome === "escalated"
        ? "ESCALATED"
        : "CANCELLED";

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <div className="label">Result</div>
          <div className={cn("mt-1 text-base font-medium", tone, numeric)}>{label}</div>
        </div>
        <Figure label="ML detection" value={run.mlDetectedSec} />
        <Figure label="Threshold detection" value={run.thresholdDetectedSec} />
        <Figure label="Recovery time" value={run.recoverySec} />
      </div>
      {run.incidentId ? (
        <Link
          href={`/incidents?id=${run.incidentId}`}
          className="text-sm text-brand-text hover:underline"
        >
          View incident {run.incidentId}
        </Link>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={cn("mt-1 text-base text-text", numeric)}>
        {value === null ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            {value}
            <span className="text-muted"> s</span>
          </>
        )}
      </div>
    </div>
  );
}
