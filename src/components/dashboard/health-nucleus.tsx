"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { healthLabel } from "@/lib/simulation/health";
import { criticalCount } from "@/lib/store/selectors";
import { COUNTS } from "@/lib/mock-data/constants";
import { HEALTH_TONE, TONE_DOT, TONE_STROKE, TONE_TEXT } from "@/lib/tone";

/** Ring geometry in viewBox units; stroke is flat, never glowing. */
const SIZE = 148;
const STROKE = 4;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;

/**
 * The health nucleus: one ring carrying the weighted cluster health score, with
 * the fleet counts underneath. The ring only moves when the score moves — there
 * is no perpetual animation while production is healthy (SPEC §8).
 */
export function HealthNucleus() {
  const score = useSentinelStore((s) => s.cluster.healthScore);
  const online = useSentinelStore((s) => s.cluster.servicesOnline);
  const services = useSentinelStore((s) => s.services);
  const reduced = useReducedMotion();

  const label = healthLabel(score);
  const tone = HEALTH_TONE[label];
  const critical = criticalCount(services);
  const offset = CIRC * (1 - Math.max(0, Math.min(100, score)) / 100);

  const indicators = [
    { label: "Services", value: `${online}/${COUNTS.services}` },
    { label: "Containers", value: String(COUNTS.containers) },
    { label: "Databases", value: String(COUNTS.databases) },
    { label: "Critical", value: String(critical) },
  ];

  return (
    <Panel>
      <PanelHeader
        title="System health"
        actions={
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                TONE_DOT[tone],
                tone !== "ok" && !reduced && "animate-pulse",
              )}
            />
            <span className={cn("text-xs font-medium", TONE_TEXT[tone])}>
              {label}
            </span>
          </span>
        }
      />

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-6">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="-rotate-90"
            aria-hidden
          >
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke="var(--border)"
              strokeWidth={STROKE}
            />
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={TONE_STROKE[tone]}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={offset}
              style={{
                transition: reduced
                  ? undefined
                  : "stroke-dashoffset 180ms ease-out, stroke 180ms ease-out",
              }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className={cn("text-2xl text-text metric")}>
              <AnimatedNumber value={score} decimals={1} />
              <span className="text-lg text-text-2">%</span>
            </div>
            <div className="label mt-1">Health score</div>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-4 border-t border-border">
        {indicators.map((ind, i) => (
          <div
            key={ind.label}
            className={cn(
              "px-3 py-3 text-center",
              i > 0 && "border-l border-border",
            )}
          >
            <dd className={cn("text-sm text-text", numeric)}>{ind.value}</dd>
            <dt className="label mt-0.5">{ind.label}</dt>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
