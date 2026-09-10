export { cn } from "cn";

/**
 * Class string for numeric / mono surfaces: metric values, ids, timestamps,
 * scores, logs. Applies IBM Plex Mono + tabular figures so digits never jitter.
 * Prefer this over hand-writing `font-mono tabular-nums` everywhere.
 *
 *   <span className={numeric}>{score.toFixed(2)}</span>
 */
export const numeric = "font-numeric";
