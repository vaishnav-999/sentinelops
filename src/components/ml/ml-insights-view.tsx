"use client";

import Link from "next/link";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { BASELINE_LABEL, BASELINE_TONE, TONE_BADGE, TONE_TEXT } from "@/lib/tone";
import { PipelineRow } from "./pipeline-row";
import { AnomalyScoreChart, BaselineChart } from "./baseline-chart";

/**
 * /ml-insights — how detection actually works, and what has and has not been
 * measured.
 *
 * Academic honesty (AGENTS.md, SPEC §28) is the constraint that shapes this
 * page: operational figures are live but labelled simulated, the detector
 * outputs an anomaly score and nothing else, the fault label comes from the
 * Diagnoser as a "signature match", and every research metric reads "—".
 */

/** The feature vector the detector scores. */
const FEATURES = [
  "cpu",
  "memory",
  "memory_slope",
  "p95_latency",
  "error_rate",
  "throughput",
] as const;

const RESEARCH_METRICS = [
  "Precision",
  "Recall",
  "F1 score",
  "False positive rate",
  "MTTD improvement",
  "MTTR improvement",
] as const;

export function MlInsightsView() {
  return (
    <div className="flex flex-col gap-3">
      <PipelineRow />
      <ModelCards />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <BaselineChart />
        <AnomalyScoreChart />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <ContributionPanel />
        </div>
        <div className="lg:col-span-7">
          <ResearchEvaluation />
        </div>
      </div>

      <MethodologyNote />
    </div>
  );
}

function ModelCards() {
  const anomaly = useSentinelStore((s) => s.anomaly);
  const diagnosis = useSentinelStore((s) => s.diagnosis);
  const settings = useSentinelStore((s) => s.settings);
  const tone = BASELINE_TONE[anomaly.baseline];

  return (
    <Panel>
      <PanelHeader
        title="Anomaly detection"
        actions={<span className="text-xs text-muted">Demo · simulated telemetry</span>}
      />
      <div className="grid grid-cols-2 divide-border lg:grid-cols-4 lg:divide-x">
        <Cell label="Model">
          <span className="text-base text-text">Isolation Forest</span>
          <Note>Unsupervised · anomaly score only</Note>
        </Cell>
        <Cell label="Model status">
          <Badge variant={TONE_BADGE.warn} className="font-normal">
            Simulated — training pending
          </Badge>
          <Note>No trained model is shipped with this build</Note>
        </Cell>
        <Cell label="Baseline window">
          <span className={cn("text-base text-text", numeric)}>
            {settings.baselineWindowHours}h
          </span>
          <Note>Rolling learned envelope</Note>
        </Cell>
        <Cell label="Anomaly score">
          <span className={cn("text-xl", numeric, TONE_TEXT[tone])}>
            {anomaly.score.toFixed(2)}
          </span>
          <Note>{BASELINE_LABEL[anomaly.baseline]} · decision at 0.70</Note>
        </Cell>
      </div>

      <div className="grid grid-cols-1 gap-4 border-t border-border px-4 py-3 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="label">Signature match</div>
          <div className="mt-1 flex items-baseline gap-2">
            {diagnosis ? (
              <>
                <span className={cn("text-base text-text", numeric)}>
                  {diagnosis.signature}
                </span>
                <span className={cn("text-sm text-text-2", numeric)}>
                  {Math.round(diagnosis.match * 100)}%
                </span>
              </>
            ) : (
              <span className="text-sm text-muted">
                No signature matched — nothing to diagnose
              </span>
            )}
          </div>
          <Note>
            The Diagnoser assigns the fault type; the detector never does.
          </Note>
        </div>

        <div className="min-w-0">
          <div className="label">Features</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {FEATURES.map((f) => (
              <span
                key={f}
                className={cn(
                  "rounded-sm border border-border px-1.5 py-0.5 text-xs text-text-2",
                  numeric,
                )}
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Live feature attribution. Labelled "Simulated attribution": these weights
 * come from the scenario definition, not from a fitted model, and saying so is
 * the difference between a demo and a false claim.
 */
function ContributionPanel() {
  const contributions = useSentinelStore((s) => s.anomaly.contributions);
  const score = useSentinelStore((s) => s.anomaly.score);

  const rows = contributions ?? [];
  const abnormal = score >= 0.7;

  return (
    <Panel className="h-full">
      <PanelHeader
        title="Feature contribution"
        actions={<span className="text-xs text-muted">Simulated attribution</span>}
      />
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center px-4 py-8">
          <p className="text-sm text-muted">
            No active anomaly — contributions appear while a fault is being
            scored.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3 px-4 py-4">
          {rows.map((c) => (
            <li key={c.feature} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-xs text-text-2">
                {c.feature}
              </span>
              <span className="h-1.5 min-w-0 flex-1 rounded-full bg-hover">
                <span
                  className={cn(
                    "block h-full rounded-full",
                    abnormal ? "bg-crit" : "bg-ai",
                  )}
                  style={{ width: `${Math.min(100, c.weight)}%` }}
                />
              </span>
              <span className={cn("w-10 shrink-0 text-right text-xs text-text", numeric)}>
                {c.weight}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ResearchEvaluation() {
  return (
    <Panel className="h-full">
      <PanelHeader
        title="Research evaluation"
        actions={
          <Badge variant={TONE_BADGE.muted} className="font-normal">
            Awaiting evaluation
          </Badge>
        }
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-4 sm:grid-cols-3">
        {RESEARCH_METRICS.map((metric) => (
          <div key={metric} className="min-w-0">
            <div className="label">{metric}</div>
            <div className={cn("mt-1 text-xl text-muted", numeric)}>—</div>
            <div className="mt-0.5 text-xs text-muted">Awaiting evaluation</div>
          </div>
        ))}
      </div>
      <p className="border-t border-border px-4 py-3 text-sm text-text-2">
        Experimental results will populate after model evaluation.
      </p>
    </Panel>
  );
}

function MethodologyNote() {
  return (
    <Panel>
      <PanelHeader title="Methodology" />
      <div className="flex flex-col gap-2 px-4 py-4">
        <p className="text-sm text-text-2">
          Ground truth: Chaos Lab fault injections with known start time, type
          and target. Baseline: static threshold rules.
        </p>
        <p className="text-sm text-muted">
          Each run records the injection time, the anomaly detector&rsquo;s fire
          time and the static rule&rsquo;s fire time, which is what a detection
          comparison will be computed from once the model is trained.
        </p>
        <Link
          href="/chaos-lab"
          className="text-sm text-brand-text underline-offset-4 hover:underline"
        >
          Open Chaos Lab
        </Link>
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
    <div className="border-b border-border px-4 py-3 last:border-b-0 lg:border-b-0">
      <div className="label">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-xs text-muted">{children}</div>;
}
