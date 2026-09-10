import type { IslandState } from "@/lib/types";

/**
 * The product story: observe → detect → understand → remediate → verify
 * (SPEC §27). Shared by the page-header lifecycle strip and the Status Island
 * so the two can never disagree about which stage is live.
 */

export const LIFECYCLE_STAGES = [
  "observe",
  "detect",
  "understand",
  "remediate",
  "verify",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  observe: "Observe",
  detect: "Detect",
  understand: "Understand",
  remediate: "Remediate",
  verify: "Verify",
};

/** Idle (`operational`) sits on Observe — the platform is always watching. */
export function currentLifecycleStage(state: IslandState): LifecycleStage {
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

export type LifecycleTone = "pending" | "active" | "complete" | "failed";

export function lifecycleTone(
  stage: LifecycleStage,
  island: IslandState,
): LifecycleTone {
  if (island === "recovered") return "complete";
  if (island === "escalated") {
    // No safe automatic action existed, so Remediate is where the run stopped.
    if (stage === "remediate") return "failed";
    if (stage === "verify") return "pending";
    return "complete";
  }
  const ci = LIFECYCLE_STAGES.indexOf(currentLifecycleStage(island));
  const si = LIFECYCLE_STAGES.indexOf(stage);
  if (si < ci) return "complete";
  if (si === ci) return "active";
  return "pending";
}
