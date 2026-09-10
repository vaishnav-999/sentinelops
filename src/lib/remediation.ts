import type {
  Incident,
  RemediationExecution,
  RemediationMode,
  RemediationOutcome,
  RemediationPolicy,
  SentinelSettings,
} from "@/lib/types";
import type { Tone } from "@/lib/tone";

/**
 * Pure read-models behind /auto-heal. Every figure the page shows is derived
 * here from the store's audit trail, so nothing on that screen is a number
 * typed into JSX — and the same derivation is testable without React.
 */

/* ------------------------------------------------------------------ */
/* Labels & tones                                                      */
/* ------------------------------------------------------------------ */

export const MODE_LABEL: Record<RemediationMode, string> = {
  automatic: "Automatic",
  manual: "Manual approval",
};

export const MODE_TONE: Record<RemediationMode, Tone> = {
  automatic: "brand",
  manual: "muted",
};

export const OUTCOME_LABEL: Record<RemediationOutcome, string> = {
  in_progress: "Running",
  success: "Success",
  failed: "Failed",
  escalated: "Escalated",
};

export const OUTCOME_TONE: Record<RemediationOutcome, Tone> = {
  in_progress: "brand",
  success: "ok",
  failed: "crit",
  escalated: "warn",
};

/* ------------------------------------------------------------------ */
/* Autonomy status strip                                               */
/* ------------------------------------------------------------------ */

export interface AutonomyStatus {
  /** "Enabled" / "Dry-run" / "Disabled". */
  label: string;
  tone: Tone;
  autoHealsToday: number;
  /**
   * Successful automatic actions as a share of the ones that reached a verdict,
   * percent. Null until at least one execution has completed — never guessed.
   */
  successRatePct: number | null;
  successSamples: number;
  /**
   * Executions of a `restricted` policy that actually committed an action.
   * By construction this is 0: restricted policies are manual-only. It is
   * counted rather than hardcoded so a policy change would show up here.
   */
  unsafeActions: number;
  /** The two configured guardrails, as sentences. */
  guardrails: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function autonomyStatus(
  settings: SentinelSettings,
  executions: RemediationExecution[],
  incidents: Incident[],
  policies: RemediationPolicy[],
  now: number,
): AutonomyStatus {
  const label = !settings.autoRemediation
    ? "Disabled"
    : settings.dryRun
      ? "Dry-run"
      : "Enabled";
  const tone: Tone = !settings.autoRemediation
    ? "crit"
    : settings.dryRun
      ? "warn"
      : "ok";

  const settled = executions.filter((e) => e.outcome !== "in_progress");
  const succeeded = settled.filter((e) => e.outcome === "success").length;

  const restricted = new Set(
    policies.filter((p) => p.risk === "restricted").map((p) => p.id),
  );

  return {
    label,
    tone,
    autoHealsToday: incidents.filter(
      (i) => i.auto && i.status === "resolved" && now - i.detectedAt <= DAY_MS,
    ).length,
    successRatePct:
      settled.length === 0
        ? null
        : Math.round((succeeded / settled.length) * 100),
    successSamples: settled.length,
    unsafeActions: settled.filter(
      (e) => !e.dryRun && e.outcome === "success" && restricted.has(e.policyId),
    ).length,
    guardrails: [
      `Max ${settings.restartLimit} auto-actions per service per ${Math.round(
        settings.guardrailWindowSec / 60,
      )} min`,
      `Cooldown ${settings.cooldownSec}s`,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Policy table                                                        */
/* ------------------------------------------------------------------ */

export interface PolicyRow {
  policy: RemediationPolicy;
  /** Epoch ms this policy last selected an action, or null. */
  lastTriggeredAt: number | null;
  executions: number;
}

/** Policies with their usage, in seed order (automatic first). */
export function policyRows(
  policies: RemediationPolicy[],
  executions: RemediationExecution[],
): PolicyRow[] {
  return policies.map((policy) => {
    const mine = executions.filter((e) => e.policyId === policy.id);
    const lastTriggeredAt = mine.reduce<number | null>(
      (latest, e) => (latest === null || e.startedAt > latest ? e.startedAt : latest),
      null,
    );
    return { policy, lastTriggeredAt, executions: mine.length };
  });
}

/* ------------------------------------------------------------------ */
/* Executions list                                                     */
/* ------------------------------------------------------------------ */

/** Newest first — the order an operator reads an audit trail in. */
export function recentExecutions(
  executions: RemediationExecution[],
): RemediationExecution[] {
  return executions.slice().sort((a, b) => b.startedAt - a.startedAt);
}

export function isLive(execution: RemediationExecution): boolean {
  return execution.outcome === "in_progress";
}

/* ------------------------------------------------------------------ */
/* Terminal keyword highlighting                                       */
/* ------------------------------------------------------------------ */

export interface TerminalToken {
  text: string;
  /** null = ordinary terminal text. */
  tone: Tone | null;
}

/**
 * The words that carry the meaning of a transcript line, coloured so a run can
 * be read at a glance: what was detected, what was approved, what passed and
 * what did not. Everything else stays neutral — colouring whole lines would
 * make the panel a rainbow and say nothing.
 */
const KEYWORDS: { pattern: RegExp; tone: Tone }[] = [
  { pattern: /\bDRY RUN\b/g, tone: "warn" },
  { pattern: /\bguardrail\b/gi, tone: "warn" },
  { pattern: /\banomaly\b/gi, tone: "ai" },
  { pattern: /\bapproved\b/gi, tone: "brand" },
  { pattern: /\bpassed\b/gi, tone: "ok" },
  { pattern: /\bRESOLVED\b/g, tone: "ok" },
  { pattern: /\bfailed\b/gi, tone: "crit" },
  { pattern: /\bESCALATED\b/g, tone: "crit" },
];

export function tokenizeTerminal(text: string): TerminalToken[] {
  const hits: { start: number; end: number; tone: Tone }[] = [];

  for (const { pattern, tone } of KEYWORDS) {
    // Each pattern carries /g, so reset lastIndex before every reuse.
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      hits.push({ start: match.index, end: match.index + match[0].length, tone });
      match = pattern.exec(text);
    }
  }

  // Earlier match wins; overlaps are dropped so segments never interleave.
  hits.sort((a, b) => a.start - b.start);

  const tokens: TerminalToken[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) {
      tokens.push({ text: text.slice(cursor, hit.start), tone: null });
    }
    tokens.push({ text: text.slice(hit.start, hit.end), tone: hit.tone });
    cursor = hit.end;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor), tone: null });
  return tokens;
}
