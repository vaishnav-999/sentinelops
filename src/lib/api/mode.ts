/**
 * Which data source the console runs on. Build-time constants, so the server
 * render and the client agree (no hydration drift).
 *
 *   mock (default)  the in-browser simulation engine
 *   http            the FastAPI backend (docker-compose.live.yml)
 */
export const DATA_SOURCE = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "mock";

export const IS_LIVE = DATA_SOURCE === "http";

/** Empty string = same origin (behind the reverse proxy in production). */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "");

/** Short provenance marker shown wherever telemetry is displayed. */
export const DATA_LABEL = IS_LIVE ? "Live · Docker telemetry" : "Demo · simulated data";

/** Qualifier for figures derived from runs, e.g. "Live · 4 runs". */
export const SAMPLE_QUALIFIER = IS_LIVE ? "Live" : "Simulated";
