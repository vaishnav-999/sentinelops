"use client";

import Link from "next/link";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { BASELINE_LABEL, BASELINE_TONE, TONE_BADGE, TONE_TEXT } from "@/lib/tone";
import type { ResearchMetrics } from "@/lib/types";
import { DATA_LABEL, IS_LIVE } from "@/lib/api/mode";
import { modelStatusLabel } from "@/lib/live/model-status";
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

const RESEARCH_METRICS: { label: string; key: keyof ResearchMetrics }[] = [
  { label: "Precision", key: "precision" },
  { label: "Recall", key: "recall" },
  { label: "F1 score", key: "f1" },
  { label: "False positive rate", key: "falsePositiveRate" },
  { label: "MTTD improvement", key: "mttdImprovement" },
  { label: "MTTR improvement", key: "mttrImprovement" },
];

/** Score at which the detector fires: the live backend fires at 0.60. */
const DECISION_SCORE = IS_LIVE ? 0.6 : 0.7;

function formatResearch(key: keyof ResearchMetrics, value: number): string {
  if (key === "mttdImprovement" || key === "mttrImprovement") {
    return `${value.toFixed(1)}%`;
  }
  if (key === "f1") return value.toFixed(3);
  return `${(value * 100).toFixed(1)}%`;
}

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
  const model = useSentinelStore((s) => s.model);
  const tone = BASELINE_TONE[anomaly.baseline];
  const active = model?.status === "active";

  return (
    <Panel>
      <PanelHeader
        title="Anomaly detection"
        actions={<span className="text-xs text-muted">{DATA_LABEL}</span>}
      />
      <div className="grid grid-cols-2 divide-border lg:grid-cols-4 lg:divide-x">
        <Cell label="Model">
          <span className="text-base text-text">Isolation Forest</span>
          <Note>Unsupervised · anomaly score only</Note>
        </Cell>
        <Cell label="Model status">
          <Badge
            variant={active ? TONE_BADGE.ok : TONE_BADGE.warn}
            className="font-normal"
          >
            {modelStatusLabel(model)}
          </Badge>
          <Note>
            {IS_LIVE
              ? "One model per service, fitted on live healthy samples"
              : "No trained model is shipped with this build"}
          </Note>
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
          <Note>
            {BASELINE_LABEL[anomaly.baseline]} · decision at {DECISION_SCORE.toFixed(2)}
          </Note>
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
 * Feature attribution. In demo mode the weights come from the scenario
 * definition, so they are labelled "Simulated attribution". In live mode they
 * are each feature's share of the z-score deviation from the learned baseline —
 * not Isolation Forest internals, hence "Deviation attribution".
 */
function ContributionPanel() {
  const contributions = useSentinelStore((s) => s.anomaly.contributions);
  const score = useSentinelStore((s) => s.anomaly.score);

  const rows = contributions ?? [];
  const abnormal = score >= DECISION_SCORE;

  return (
    <Panel className="h-full">
      <PanelHeader
        title="Feature contribution"
        actions={
          <span className="text-xs text-muted">
            {IS_LIVE ? "Deviation attribution" : "Simulated attribution"}
          </span>
        }
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
  const research = useSentinelStore((s) => s.research);
  const evaluated = research !== null && research.runs >= research.minRuns;

  return (
    <Panel className="h-full">
      <PanelHeader
        title="Research evaluation"
        actions={
          <Badge
            variant={evaluated ? TONE_BADGE.ai : TONE_BADGE.muted}
            className={cn("font-normal", numeric)}
          >
            {evaluated
              ? `${research.runs} recorded runs`
              : research
                ? `Awaiting evaluation · ${research.runs}/${research.minRuns} runs`
                : "Awaiting evaluation"}
          </Badge>
        }
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-4 sm:grid-cols-3">
        {RESEARCH_METRICS.map(({ label, key }) => {
          const value = research?.[key];
          const known = typeof value === "number";
          return (
            <div key={key} className="min-w-0">
              <div className="label">{label}</div>
              <div
                className={cn("mt-1 text-xl", numeric, known ? "text-text" : "text-muted")}
              >
                {known ? formatResearch(key, value) : "—"}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {known ? "Measured from recorded runs" : "Awaiting evaluation"}
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-border px-4 py-3 text-sm text-text-2">
        {IS_LIVE
          ? research && evaluated
            ? `${research.falsePositives} false positives across ${research.healthyWindows} healthy service-minutes. MTTR improvement needs a manual baseline and stays unmeasured.`
            : "Metrics compute once enough Chaos Lab runs have been recorded."
          : "Experimental results will populate after model evaluation."}
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
          time and the static rule&rsquo;s fire time.{" "}
          {IS_LIVE
            ? "Precision, recall and F1 are computed from those runs; false positives are detector firings outside any run window."
            : "That is what a detection comparison will be computed from once the model is trained."}
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
