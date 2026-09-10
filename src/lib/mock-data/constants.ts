import type { EnvironmentId, TimeRange } from "@/lib/types";

/**
 * Deterministic anchor for all seed timestamps.
 *
 * IMPORTANT: never call Date.now() at module scope — seed data is imported on
 * the server and must render identically on client and server (no hydration
 * drift). All historical timestamps are derived from this fixed constant.
 * The live engine uses the real wall clock only after client mount.
 */
export const SEED_NOW = Date.UTC(2026, 8, 11, 16, 0, 0); // 2026-09-11T16:00:00Z

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Fixed counts surfaced across the product (SPEC §36). */
export const COUNTS = {
  services: 6,
  containers: 8,
  databases: 1,
  caches: 1,
} as const;

/** Length of the telemetry ring buffers, in samples. */
export const RING_SIZE = 60;

export interface EnvironmentMeta {
  id: EnvironmentId;
  label: string;
  cluster: string;
}

export const ENVIRONMENTS: EnvironmentMeta[] = [
  { id: "production", label: "Production", cluster: "sentinel-prod-cluster" },
  { id: "staging", label: "Staging", cluster: "sentinel-staging-cluster" },
  {
    id: "development",
    label: "Development",
    cluster: "sentinel-dev-cluster",
  },
];

/** Seeded operator shown in the shell profile. */
export const OPERATOR = {
  name: "Maya Chen",
  role: "On-call operator",
  initials: "MC",
} as const;

export const TIME_RANGES: TimeRange[] = ["15m", "1h", "6h", "24h", "7d"];
