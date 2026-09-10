import type { Incident } from "@/lib/types";

/**
 * Placeholder for the Gemini post-incident narrative (SPEC 37).
 *
 * It renders nothing today: the server route, the deterministic fallback and
 * the "AI-generated narrative from simulated telemetry" label all land in a
 * later phase. The seam exists now so the detail sheet does not have to change
 * shape when it does.
 */
export function AiIncidentReport({ incident }: { incident: Incident }) {
  void incident;
  return null;
}
