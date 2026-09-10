"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel } from "@/components/ui/panel";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Sparkline, type SparkTone } from "@/components/charts/sparkline";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { clusterValue, trailDelta } from "@/lib/store/selectors";
import {
  METRIC_META,
  formatCompactNumber,
  formatWindow,
} from "@/lib/metrics";
import {
  METRIC_THRESHOLDS,
  UPTIME_THRESHOLD,
  breachingServices,
  clusterBreaches,
  type MetricKey,
} from "@/lib/simulation/thresholds";
import type { ClusterMetrics } from "@/lib/types";
import { TONE_DOT, TONE_TEXT, type Tone } from "@/lib/tone";

/**
 * Six cluster headline metrics. Uptime is not a walked metric — it has no
 * threshold entry and no trail delta worth showing — so it is described
 * separately rather than bent into the MetricKey union.
 */
const CARDS: (MetricKey | "uptime")[] = [
  "cpu",
  "memory",
  "latencyP95",
  "errorRate",
  "throughput",
  "uptime",
];

export function MetricsStrip() {
  const cluster = useSentinelStore((s) => s.cluster);
  const history = useSentinelStore((s) => s.clusterHistory);
  const trail = useSentinelStore((s) => s.clusterTrail);
  const services = useSentinelStore((s) => s.services);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {CARDS.map((card) =>
        card === "uptime" ? (
          <UptimeCard
            key={card}
            cluster={cluster}
            history={history}
            trail={trail}
          />
        ) : (
          <MetricCard
            key={card}
            metric={card}
            cluster={cluster}
            history={history}
            trail={trail}
            breaching={breachingServices(services, card)}
          />
        ),
      )}
    </div>
  );
}

function MetricCard({
  metric,
  cluster,
  history,
  trail,
  breaching,
}: {
  metric: MetricKey;
  cluster: ClusterMetrics;
  history: ClusterMetrics[];
  trail: ClusterMetrics[];
  breaching: string[];
}) {
  const meta = METRIC_META[metric];
  const value = clusterValue(cluster, metric);
  const pick = (c: ClusterMetrics) => clusterValue(c, metric);

  const clusterBreach = clusterBreaches(value, metric);
  const tone: Tone = clusterBreach
    ? "crit"
    : breaching.length > 0
      ? "warn"
      : "ok";

  const note = clusterBreach
    ? METRIC_THRESHOLDS[metric].label
    : breaching.length === 1
      ? `${breaching.length} service over threshold`
      : breaching.length > 1
        ? `${breaching.length} services over threshold`
        : null;

  return (
    <MetricCardShell
      label={meta.label}
      tone={tone}
      note={note}
      value={
        <AnimatedNumber
          value={value}
          decimals={meta.decimals}
          format={
            metric === "throughput"
              ? (v) => formatCompactNumber(v)
              : undefined
          }
        />
      }
      unit={metric === "throughput" ? null : meta.unit}
      delta={
        <Delta
          trail={trail}
          cluster={cluster}
          pick={pick}
          decimals={meta.decimals}
          higherIsWorse={meta.higherIsWorse}
          compact={metric === "throughput"}
        />
      }
      spark={history.map(pick)}
      sparkTone={tone === "ok" ? "brand" : tone}
    />
  );
}

function UptimeCard({
  cluster,
  history,
  trail,
}: {
  cluster: ClusterMetrics;
  history: ClusterMetrics[];
  trail: ClusterMetrics[];
}) {
  const value = cluster.uptimePct;
  const breach = value < UPTIME_THRESHOLD;
  const tone: Tone = breach ? "warn" : "ok";

  return (
    <MetricCardShell
      label="Uptime"
      tone={tone}
      note={breach ? `Below ${UPTIME_THRESHOLD}%` : "Rolling 30 days"}
      value={<AnimatedNumber value={value} decimals={3} />}
      unit="%"
      delta={
        <Delta
          trail={trail}
          cluster={cluster}
          pick={(c) => c.uptimePct}
          decimals={3}
          higherIsWorse={false}
        />
      }
      spark={history.map((c) => c.uptimePct)}
      sparkTone={breach ? "warn" : "brand"}
    />
  );
}

/** Shared card body: label row, 24px value, delta line, 32px sparkline. */
function MetricCardShell({
  label,
  tone,
  note,
  value,
  unit,
  delta,
  spark,
  sparkTone,
}: {
  label: string;
  tone: Tone;
  note: string | null;
  value: React.ReactNode;
  unit: string | null;
  delta: React.ReactNode;
  spark: number[];
  sparkTone: SparkTone;
}) {
  return (
    <Panel className="group transition-colors hover:border-border-strong">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="label">{label}</span>
          {tone !== "ok" ? (
            <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
          ) : null}
        </div>

        <div className="flex items-baseline gap-1">
          <span className="metric text-xl text-text">{value}</span>
          {unit ? <span className="text-xs text-muted">{unit}</span> : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          {delta}
          <span
            className={cn(
              "truncate text-xs",
              tone === "ok" ? "text-muted" : TONE_TEXT[tone],
            )}
          >
            {note}
          </span>
        </div>
      </div>

      <Sparkline
        values={spark}
        tone={sparkTone}
        height={32}
        className="mt-auto"
      />
    </Panel>
  );
}

/** "+4.2 vs 5m" — tone says whether that movement is good or bad. */
function Delta({
  trail,
  cluster,
  pick,
  decimals,
  higherIsWorse,
  compact = false,
}: {
  trail: ClusterMetrics[];
  cluster: ClusterMetrics;
  pick: (c: ClusterMetrics) => number;
  decimals: number;
  higherIsWorse: boolean;
  compact?: boolean;
}) {
  const delta = trailDelta(trail, cluster, pick);

  if (!delta) {
    return <span className={cn("text-xs text-muted", numeric)}>—</span>;
  }

  const { change, windowSec } = delta;
  const magnitude = Math.abs(change);
  const flat = magnitude < (decimals === 0 ? 1 : 10 ** -decimals);
  const worse = higherIsWorse ? change > 0 : change < 0;

  const body = compact
    ? formatCompactNumber(magnitude)
    : magnitude.toFixed(decimals);

  return (
    <span className={cn("shrink-0 text-xs", numeric)}>
      <span
        className={
          flat ? "text-muted" : worse ? "text-crit-text" : "text-ok-text"
        }
      >
        {flat ? "±" : change > 0 ? "+" : "−"}
        {body}
      </span>
      <span className="text-muted"> vs {formatWindow(windowSec)}</span>
    </span>
  );
}
