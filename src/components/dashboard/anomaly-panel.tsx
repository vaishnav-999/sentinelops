"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { clusterBaseline, clusterValue } from "@/lib/store/selectors";
import { METRIC_META, formatMetricValue } from "@/lib/metrics";
import { baselineBand, type MetricKey } from "@/lib/simulation/thresholds";
import {
  BASELINE_LABEL,
  BASELINE_TONE,
  TONE_BADGE,
  TONE_DOT,
  TONE_TEXT,
  type Tone,
} from "@/lib/tone";

/** The four signals the detector actually scores; throughput is informational. */
const COMPARED: MetricKey[] = ["cpu", "memory", "latencyP95", "errorRate"];

/**
 * Anomaly Intelligence (SPEC §8).
 *
 * Per AGENTS.md academic honesty: Isolation Forest yields an anomaly score and
 * nothing else, so the spec's "Confidence" slot shows the Diagnoser's signature
 * match instead — and reads "—" until a signature has actually matched.
 */
export function AnomalyPanel() {
  const anomaly = useSentinelStore((s) => s.anomaly);
  const diagnosis = useSentinelStore((s) => s.diagnosis);
  const cluster = useSentinelStore((s) => s.cluster);
  const services = useSentinelStore((s) => s.services);

  const tone = BASELINE_TONE[anomaly.baseline];
  const baseline = clusterBaseline(services);

  return (
    <Panel>
      <PanelHeader
        title="Anomaly intelligence"
        actions={
          <Badge variant="outline" className="text-muted">
            Simulated
          </Badge>
        }
      />

      <dl className="grid grid-cols-2 border-b border-border">
        <Stat label="Anomaly score" className="border-r border-border">
          <span className={cn("metric text-xl", TONE_TEXT[tone])}>
            <AnimatedNumber value={anomaly.score} decimals={2} />
          </span>
        </Stat>
        <Stat label="Baseline">
          <Badge variant={TONE_BADGE[tone]}>
            {BASELINE_LABEL[anomaly.baseline]}
          </Badge>
        </Stat>
        <Stat
          label="Signature match"
          className="border-r border-t border-border"
        >
          <span className={cn("text-sm text-text", numeric)}>
            {diagnosis ? `${Math.round(diagnosis.match * 100)}%` : "—"}
          </span>
          {diagnosis ? (
            <span className={cn("ml-1.5 text-xs text-muted", numeric)}>
              {diagnosis.signature}
            </span>
          ) : (
            <span className="ml-1.5 text-xs text-muted">No match</span>
          )}
        </Stat>
        <Stat label="Model" className="border-t border-border">
          <span className="text-sm text-text">Isolation Forest</span>
        </Stat>
      </dl>

      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              TONE_DOT[tone],
            )}
          />
          <p className="text-sm text-text-2">
            {anomaly.note ?? "No abnormal behaviour detected."}
            {anomaly.serviceId ? (
              <span className={cn(" text-text", numeric)}>
                {" "}
                {anomaly.serviceId}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <span className="label">Current vs learned baseline</span>
          <span className="label">24h window</span>
        </div>
        {COMPARED.map((key) => (
          <BaselineRow
            key={key}
            metric={key}
            current={clusterValue(cluster, key)}
            center={clusterValue(baseline, key)}
          />
        ))}
      </div>
    </Panel>
  );
}

function Stat({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("px-4 py-3", className)}>
      <dt className="label">{label}</dt>
      <dd className="mt-1 flex h-7 items-center">{children}</dd>
    </div>
  );
}

/**
 * One signal as a track: the grey span is the envelope the walk normally stays
 * inside, the coloured tick is where the cluster is right now.
 */
function BaselineRow({
  metric,
  current,
  center,
}: {
  metric: MetricKey;
  current: number;
  center: number;
}) {
  const band = baselineBand(center, metric);
  const max = Math.max(band.high, current) * 1.15 || 1;

  const pct = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  const outside = current > band.high || current < band.low;
  const far = current > band.high * 1.25 || current < band.low * 0.75;
  const tone: Tone = far ? "crit" : outside ? "warn" : "ok";

  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 truncate text-xs text-text-2">
        {METRIC_META[metric].label}
      </span>

      <div className="relative h-1.5 min-w-0 flex-1 rounded-full bg-hover">
        <span
          className="absolute inset-y-0 rounded-full bg-border-strong"
          style={{
            left: `${pct(band.low)}%`,
            width: `${Math.max(1, pct(band.high) - pct(band.low))}%`,
          }}
        />
        <span
          className={cn(
            "absolute -inset-y-1 w-0.5 rounded-full transition-[left] duration-150 ease-out",
            TONE_DOT[tone],
          )}
          style={{ left: `${pct(current)}%` }}
        />
      </div>

      <span
        className={cn(
          "w-16 shrink-0 text-right text-xs",
          numeric,
          tone === "ok" ? "text-text-2" : TONE_TEXT[tone],
        )}
      >
        {formatMetricValue(current, metric)}
      </span>
    </div>
  );
}
