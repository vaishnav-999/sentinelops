import type { HealthLabel } from "@/lib/simulation/health";
import type { AnomalyBaseline, ServiceStatus, Severity } from "@/lib/types";

/**
 * One mapping from domain state to the five semantic colors, so a status never
 * renders green in the table and amber in the event stream. Solids are for dots
 * and rails; the `*-text` tokens are for labels and values (AGENTS.md).
 */

export type Tone = "ok" | "warn" | "crit" | "brand" | "ai" | "muted";

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
  brand: "bg-brand",
  ai: "bg-ai",
  muted: "bg-muted",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok-text",
  warn: "text-warn-text",
  crit: "text-crit-text",
  brand: "text-brand-text",
  ai: "text-ai-text",
  muted: "text-muted",
};

export const TONE_STROKE: Record<Tone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  crit: "var(--crit)",
  brand: "var(--brand)",
  ai: "var(--ai)",
  muted: "var(--muted)",
};

/** Badge variants that exist in components/ui/badge.tsx. */
export const TONE_BADGE: Record<Tone, "ok" | "warn" | "crit" | "brand" | "ai" | "outline"> = {
  ok: "ok",
  warn: "warn",
  crit: "crit",
  brand: "brand",
  ai: "ai",
  muted: "outline",
};

export const SERVICE_STATUS_TONE: Record<ServiceStatus, Tone> = {
  healthy: "ok",
  degraded: "warn",
  critical: "crit",
  recovering: "brand",
};

export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  critical: "Critical",
  recovering: "Recovering",
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  info: "muted",
  ok: "ok",
  warn: "warn",
  crit: "crit",
  ai: "ai",
};

export const BASELINE_TONE: Record<AnomalyBaseline, Tone> = {
  normal: "ok",
  elevated: "warn",
  abnormal: "crit",
};

export const BASELINE_LABEL: Record<AnomalyBaseline, string> = {
  normal: "Normal",
  elevated: "Elevated",
  abnormal: "Abnormal",
};

export const HEALTH_TONE: Record<HealthLabel, Tone> = {
  Healthy: "ok",
  Degraded: "warn",
  Critical: "crit",
};

/** Any state that should keep a slow pulse on its indicator dot. */
export function isUnsettled(status: ServiceStatus): boolean {
  return status !== "healthy";
}
