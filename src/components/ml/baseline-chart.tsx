"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { formatClockTime } from "@/lib/metrics";
import { baselineBand } from "@/lib/simulation/thresholds";

/**
 * Actual memory against the learned baseline envelope, for whichever service
 * the detector is currently watching (payment-worker while everything is calm).
 *
 * The band is derived from the service's seeded baseline via
 * `baselineBand` — the same envelope the rest of the product uses — so the
 * chart cannot disagree with the breach dots on /overview.
 */

const CHART_HEIGHT = 220;
const DECISION_THRESHOLD = 0.7;

export function BaselineChart() {
  const anomalyServiceId = useSentinelStore((s) => s.anomaly.serviceId);
  const focusId = anomalyServiceId ?? "payment-worker";
  const service = useSentinelStore((s) =>
    s.services.find((x) => x.id === focusId),
  );
  const history = useSentinelStore((s) => s.histories[focusId]);

  const band = service ? baselineBand(service.baseline.memory, "memory") : null;
  const samples = history ?? [];
  const ready = samples.length >= 2 && band !== null;

  const data = samples.map((s) => ({
    t: s.t,
    memory: s.memory,
    low: band?.low ?? 0,
    // The stacked area draws `low` then the band height on top of it.
    height: band ? band.high - band.low : 0,
  }));

  return (
    <Panel>
      <PanelHeader
        title="Memory vs learned baseline"
        actions={
          <span className={cn("text-xs text-muted", numeric)}>{focusId}</span>
        }
      />
      <div className="px-2 pb-2 pt-3" style={{ height: CHART_HEIGHT }}>
        {ready ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
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
                domain={[0, 100]}
                tickFormatter={(v: number) => `${Math.round(v)}`}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Area
                type="monotone"
                dataKey="low"
                stackId="band"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="height"
                stackId="band"
                stroke="none"
                fill="var(--ok)"
                fillOpacity={0.12}
                isAnimationActive={false}
              />
              <ReferenceLine
                y={band.high}
                stroke="var(--ok)"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                label={{
                  value: "Baseline envelope",
                  position: "right",
                  fill: "var(--ok-text)",
                  fontSize: 11,
                }}
              />
              <Line
                type="monotone"
                dataKey="memory"
                stroke="var(--brand)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <Waiting />
        )}
      </div>
    </Panel>
  );
}

/** Anomaly score over time, with the 0.70 decision line. */
export function AnomalyScoreChart() {
  const history = useSentinelStore((s) => s.anomalyHistory);
  const score = useSentinelStore((s) => s.anomaly.score);

  const ready = history.length >= 2;
  const over = score >= DECISION_THRESHOLD;

  return (
    <Panel>
      <PanelHeader
        title="Anomaly score timeline"
        actions={
          <span
            className={cn(
              "text-xs",
              numeric,
              over ? "text-crit-text" : "text-text-2",
            )}
          >
            {score.toFixed(2)}
          </span>
        }
      />
      <div className="px-2 pb-2 pt-3" style={{ height: CHART_HEIGHT }}>
        {ready ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history} margin={{ top: 4, right: 64, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
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
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v: number) => v.toFixed(2)}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <ReferenceLine
                y={DECISION_THRESHOLD}
                stroke="var(--warn)"
                strokeDasharray="4 4"
                label={{
                  value: "Decision 0.70",
                  position: "right",
                  fill: "var(--warn-text)",
                  fontSize: 11,
                }}
              />
              <Line
                type="monotone"
                dataKey="score"
                stroke={over ? "var(--crit)" : "var(--ai)"}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <Waiting />
        )}
      </div>
    </Panel>
  );
}

function Waiting() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted">
      Waiting for telemetry…
    </div>
  );
}
