"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { IslandState } from "@/lib/types";
import { AnimatedNumber } from "@/components/ui/animated-number";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const PIPELINE = [
  "observe",
  "detect",
  "understand",
  "remediate",
  "verify",
] as const;

type StageId = (typeof PIPELINE)[number];

const STAGE_LABEL: Record<StageId, string> = {
  observe: "Observe",
  detect: "Detect",
  understand: "Understand",
  remediate: "Remediate",
  verify: "Verify",
};

function currentStage(state: IslandState): StageId {
  switch (state) {
    case "operational":
      return "observe";
    case "anomaly":
      return "detect";
    case "diagnosing":
      return "understand";
    case "healing":
      return "remediate";
    case "verifying":
    case "recovered":
      return "verify";
    case "escalated":
      return "remediate";
  }
}

function stageTone(
  stage: StageId,
  island: IslandState,
): "pending" | "active" | "complete" | "failed" {
  if (island === "recovered") return "complete";
  if (island === "escalated") {
    if (stage === "remediate") return "failed";
    if (stage === "verify") return "pending";
    return "complete";
  }
  const order = PIPELINE;
  const ci = order.indexOf(currentStage(island));
  const si = order.indexOf(stage);
  if (si < ci) return "complete";
  if (si === ci) return "active";
  return "pending";
}

const ISLAND_COPY: Record<
  IslandState,
  { label: string; tone: "ok" | "ai" | "brand" | "warn" | "crit" }
> = {
  operational: { label: "All Systems Operational", tone: "ok" },
  anomaly: { label: "Anomaly Detected", tone: "warn" },
  diagnosing: { label: "Analyzing", tone: "ai" },
  healing: { label: "Auto-Healing", tone: "brand" },
  verifying: { label: "Verifying", tone: "brand" },
  recovered: { label: "Recovery Complete", tone: "ok" },
  escalated: { label: "Escalated", tone: "crit" },
};

const TONE_TEXT: Record<"ok" | "ai" | "brand" | "warn" | "crit", string> = {
  ok: "text-ok",
  ai: "text-ai",
  brand: "text-brand",
  warn: "text-warn",
  crit: "text-crit",
};

const TONE_DOT: Record<"ok" | "ai" | "brand" | "warn" | "crit", string> = {
  ok: "bg-ok",
  ai: "bg-ai",
  brand: "bg-brand",
  warn: "bg-warn",
  crit: "bg-crit",
};

const TONE_GLOW: Record<"ok" | "ai" | "brand" | "warn" | "crit", string> = {
  ok: "",
  ai: "shadow-[0_0_8px_var(--ai)]",
  brand: "shadow-[0_0_8px_var(--brand)]",
  warn: "shadow-[0_0_8px_var(--warn)]",
  crit: "shadow-[0_0_8px_var(--crit)]",
};

function actionText(
  island: IslandState,
  note: string | undefined,
  lastTerminal: string | undefined,
): string {
  switch (island) {
    case "operational":
      return "Observing cluster telemetry";
    case "anomaly":
      return note ?? "Abnormal behaviour detected";
    case "diagnosing":
      return "Matching feature deviation to fault signatures";
    case "healing":
      return lastTerminal ?? "Executing safe remediation";
    case "verifying":
      return "Checking service health after remediation";
    case "recovered":
      return "All health checks passed";
    case "escalated":
      return "No safe automatic action — awaiting operator";
  }
}

export function StatusIsland() {
  const island = useSentinelStore((s) => s.islandState);
  const startedAt = useSentinelStore((s) => s.islandStartedAt);
  const changedAt = useSentinelStore((s) => s.islandChangedAt);
  const clock = useSentinelStore((s) => s.cluster.t);
  const anomaly = useSentinelStore((s) => s.anomaly);
  const lastTerminal = useSentinelStore((s) => s.terminalLines.at(-1)?.text);
  const reduced = useReducedMotion();

  const copy = ISLAND_COPY[island];
  const target = anomaly.serviceId;
  const unhealthy = island !== "operational";

  let elapsed = 0;
  if (startedAt !== null) {
    const end =
      island === "recovered" || island === "escalated" ? changedAt : clock;
    elapsed = Math.max(0, Math.floor((end - startedAt) / 1000));
  }

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5"
        aria-label={copy.label}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            TONE_DOT[copy.tone],
            unhealthy && TONE_GLOW[copy.tone],
            unhealthy && !reduced && "animate-pulse",
          )}
        />
        <span className={cn("text-sm font-medium", TONE_TEXT[copy.tone])}>
          {copy.label}
        </span>
        {target && unhealthy ? (
          <span className={cn("text-xs text-text-2", numeric)}>{target}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-80 p-3">
        <div className="flex flex-wrap items-center gap-1">
          {PIPELINE.map((stage, i) => {
            const tone = stageTone(stage, island);
            return (
              <span key={stage} className="inline-flex items-center gap-1">
                {i > 0 ? <span className="text-xs text-muted">→</span> : null}
                <span
                  className={cn(
                    "text-xs",
                    tone === "active" && TONE_TEXT[copy.tone],
                    tone === "complete" && "text-ok",
                    tone === "failed" && "text-crit",
                    tone === "pending" && "text-muted",
                    tone === "active" && "font-medium",
                  )}
                >
                  {STAGE_LABEL[stage]}
                </span>
              </span>
            );
          })}
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <dt className="label">Target</dt>
            <dd className={cn("mt-1 truncate text-sm text-text", numeric)}>
              {target ?? "—"}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="label">Current action</dt>
            <dd className="mt-1 truncate text-sm text-text">
              {actionText(island, anomaly.note, lastTerminal)}
            </dd>
          </div>
        </dl>
        <div className="mt-3">
          <div className="label">Elapsed</div>
          <div className="mt-1 text-sm text-text">
            {startedAt === null ? (
              <span className={numeric}>—</span>
            ) : (
              <span>
                <AnimatedNumber value={elapsed} />
                <span className="text-muted"> s</span>
              </span>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
