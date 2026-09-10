import type { Service, ServiceStatus } from "@/lib/types";
import { clamp, round } from "./noise";

/**
 * Cluster health score, 0–100.
 *
 * Documented formula:
 *
 *   score = 100 − Σ statusPenalty(service.status) − ERROR_COEFF · Σ errorRate
 *
 * Two contributions, per the spec: weighted service status + an error-rate
 * penalty. At the seeded healthy baseline every service is `healthy`
 * (statusPenalty 0) and the error rates sum to 1.62%, so:
 *
 *   score = 100 − 0 − 0.8 · 1.62 = 98.704 → 98.7
 *
 * A single service going critical subtracts 20 outright (plus its climbing
 * error rate), so the number drops hard during an incident — good for the demo.
 */

export const STATUS_PENALTY: Record<ServiceStatus, number> = {
  healthy: 0,
  recovering: 3,
  degraded: 9,
  critical: 20,
};

export const ERROR_COEFF = 0.8;

export function computeHealthScore(services: Service[]): number {
  let penalty = 0;
  for (const s of services) {
    penalty += STATUS_PENALTY[s.status];
    penalty += ERROR_COEFF * s.metrics.errorRate;
  }
  return round(clamp(100 - penalty, 0, 100), 1);
}

export type HealthLabel = "Healthy" | "Degraded" | "Critical";

export function healthLabel(score: number): HealthLabel {
  if (score >= 90) return "Healthy";
  if (score >= 70) return "Degraded";
  return "Critical";
}

/** Count services not currently hard-down (used for "N services online"). */
export function servicesOnline(services: Service[]): number {
  return services.filter((s) => s.status !== "critical").length;
}
