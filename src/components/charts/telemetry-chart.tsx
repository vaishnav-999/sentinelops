"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { clusterValue } from "@/lib/store/selectors";
import {
  METRIC_META,
  formatAxisValue,
  formatClockTime,
  formatMetricValue,
} from "@/lib/metrics";
import {
  METRIC_THRESHOLDS,
  clusterBreaches,
  type MetricKey,
} from "@/lib/simulation/thresholds";

const METRICS: MetricKey[] = [
  "cpu",
  "memory",
  "latencyP95",
  "errorRate",
  "throughput",
];

/** Percent metrics read better pinned to a full scale than auto-zoomed. */
const FIXED_DOMAIN: Partial<Record<MetricKey, [number, number]>> = {
  cpu: [0, 100],
  memory: [0, 100],
};

const CHART_HEIGHT = 248;

/**
 * The one large Recharts surface in the product (AGENTS.md reserves Recharts for
 * this; everything else uses the inline Sparkline). Horizontal gridlines only,
 * 1.5px stroke, no dots, no legend — the panel header names the series.
 *
 * Entry animation runs once per metric switch and is then disabled, so the
 * once-a-second live append does not re-tween the whole path.
 */
export function TelemetryChart() {
  const [metric, setMetric] = useState<MetricKey>("cpu");
  /** The metric whose entry animation has already played. */
  const [settled, setSettled] = useState<MetricKey | null>(null);
  const history = useSentinelStore((s) => s.clusterHistory);
  const cluster = useSentinelStore((s) => s.cluster);
  const live = useSentinelStore((s) => s.live);
  const reduced = useReducedMotion();

  const animate = settled !== metric;

  useEffect(() => {
    const id = setTimeout(() => setSettled(metric), 600);
    return () => clearTimeout(id);
  }, [metric]);

  const meta = METRIC_META[metric];
  const threshold = METRIC_THRESHOLDS[metric];
  const current = clusterValue(cluster, metric);
  const breaching = clusterBreaches(current, metric);
  const stroke = breaching ? "var(--crit)" : "var(--brand)";

  const data = history.map((c) => ({ t: c.t, v: clusterValue(c, metric) }));
  const ready = data.length >= 2;

  return (
    <Panel>
      <PanelHeader
        title="System telemetry"
        actions={
          <ToggleGroup
            value={[metric]}
            onValueChange={(next) => {
              const picked = next[0] as MetricKey | undefined;
              if (picked) setMetric(picked);
            }}
            spacing={0}
            className="border border-border"
          >
            {METRICS.map((m) => (
              <ToggleGroupItem
                key={m}
                value={m}
                size="sm"
                className="text-xs text-text-2 aria-pressed:text-text"
              >
                {METRIC_META[m].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />

      <div className="flex items-baseline justify-between gap-4 px-4 pt-4">
        <div className="flex items-baseline gap-1">
          <span className={cn("metric text-xl", breaching ? "text-crit-text" : "text-text")}>
            {formatMetricValue(current, metric)}
          </span>
          <span className="text-xs text-muted">{meta.unit}</span>
          <span className="ml-2 text-xs text-muted">cluster mean</span>
        </div>
        <span className="label">
          {live ? "Last 60 samples · live" : "Last 60 samples · paused"}
        </span>
      </div>

      <div className="px-2 pb-2 pt-3" style={{ height: CHART_HEIGHT }}>
        {ready ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
              <CartesianGrid
                vertical={false}
                stroke="var(--border)"
                strokeOpacity={0.6}
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={formatClockTime}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
                height={20}
              />
              <YAxis
                domain={FIXED_DOMAIN[metric] ?? ["auto", "auto"]}
                tickFormatter={(v: number) => formatAxisValue(v, metric)}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip
                cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
                content={<TelemetryTooltip metric={metric} />}
              />
              <ReferenceLine
                y={threshold.value}
                stroke="var(--warn)"
                strokeDasharray="4 4"
                strokeOpacity={0.8}
                label={{
                  value: threshold.label,
                  position: "right",
                  fill: "var(--warn-text)",
                  fontSize: 11,
                }}
              />
              <Area
                type="monotone"
                dataKey="v"
                stroke={stroke}
                strokeWidth={1.5}
                fill={stroke}
                fillOpacity={0.1}
                dot={false}
                activeDot={{ r: 2.5, strokeWidth: 0, fill: stroke }}
                isAnimationActive={animate && !reduced}
                animationDuration={400}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            Waiting for telemetry…
          </div>
        )}
      </div>
    </Panel>
  );
}

function TelemetryTooltip({
  metric,
  active,
  payload,
}: {
  metric: MetricKey;
  active?: boolean;
  payload?: { payload?: { t: number; v: number } }[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-md border border-border bg-panel px-2 py-1.5 shadow-md">
      <div className={cn("text-xs text-muted", numeric)}>
        {formatClockTime(point.t)}
      </div>
      <div className="mt-0.5 text-xs text-text">
        <span className="text-text-2">{METRIC_META[metric].label} </span>
        <span className={numeric}>{formatMetricValue(point.v, metric)}</span>
        <span className="text-muted"> {METRIC_META[metric].unit}</span>
      </div>
    </div>
  );
}
