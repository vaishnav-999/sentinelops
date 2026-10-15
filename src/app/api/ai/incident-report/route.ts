import { GoogleGenAI } from "@google/genai";
import {
  METRIC_UNITS,
  REPORT_JSON_SCHEMA,
  REPORT_SYSTEM_PROMPT,
  fallbackReport,
  groundReport,
  isReportable,
  parseReport,
  toReportInput,
  type IncidentReport,
  type IncidentReportResponse,
  type ReportInput,
} from "@/lib/ai/incident-report";

/**
 * POST /api/ai/incident-report  { incident }  ->  IncidentReportResponse
 *
 * Server only: GEMINI_API_KEY never reaches the browser. Any Gemini failure
 * (no key, timeout, quota, malformed output) falls back to the deterministic
 * report, so the endpoint always answers with a usable report. Every report,
 * either source, carries a numeric grounding check against the incident.
 */

const DEFAULT_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 25_000;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 5 * 60_000;
const CACHE_MAX = 100;

const calls = new Map<string, number[]>();
const cache = new Map<string, IncidentReportResponse>();

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function rateLimited(key: string, now: number): boolean {
  const recent = (calls.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  calls.set(key, recent);
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  return false;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

/** Live mode: the backend owns sign-in, so ask it whether this cookie is valid. */
async function signedIn(request: Request): Promise<boolean | "unavailable"> {
  if (process.env.NEXT_PUBLIC_DATA_SOURCE !== "http") return true;
  const backend = (process.env.SENTINEL_BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  try {
    const res = await fetch(`${backend}/api/auth/me`, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return "unavailable";
  }
}

function remember(key: string, value: IncidentReportResponse): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function fallback(input: ReportInput, reason: string): IncidentReportResponse {
  const report = fallbackReport(input);
  return { report, source: "fallback", reason, grounding: groundReport(report, input) };
}

function fromGemini(input: ReportInput, report: IncidentReport, model: string): IncidentReportResponse {
  return { report, source: "gemini", model, grounding: groundReport(report, input) };
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return Response.json({ detail: "Origin not allowed" }, { status: 403 });
  }
  const auth = await signedIn(request);
  if (auth === "unavailable") {
    return Response.json({ detail: "Backend unreachable" }, { status: 503 });
  }
  if (!auth) {
    return Response.json({ detail: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "Invalid JSON" }, { status: 400 });
  }
  const input = toReportInput((body as { incident?: unknown } | null)?.incident);
  if (!input) {
    return Response.json({ detail: "Invalid incident" }, { status: 400 });
  }
  if (!isReportable(input)) {
    return Response.json(
      { detail: "A report is available once the incident is resolved or escalated" },
      { status: 409 },
    );
  }

  const cacheKey = `${input.id}:${input.detectedAt}:${input.status}:${input.relapsedBy ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return Response.json(cached);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(fallback(input, "Gemini is not configured"));
  }
  if (rateLimited(clientKey(request), Date.now())) {
    return Response.json(fallback(input, "Report rate limit reached"));
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  let result: IncidentReportResponse;
  try {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model,
      contents: `Metric units: ${JSON.stringify(METRIC_UNITS)}\nIncident JSON:\n${JSON.stringify(input)}`,
      config: {
        systemInstruction: REPORT_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseJsonSchema: REPORT_JSON_SCHEMA,
        temperature: 0.2,
        // Thinking models spend part of this budget before answering.
        maxOutputTokens: 4096,
        abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      },
    });
    const report = parseReport(res.text);
    result = report ? fromGemini(input, report, model) : fallback(input, "Gemini returned an unusable report");
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.warn("[ai/incident-report] Gemini call failed:", err instanceof Error ? err.message : err);
    result = fallback(input, timedOut ? "Gemini timed out" : "Gemini request failed");
  }
  if (result.source === "gemini") remember(cacheKey, result);
  return Response.json(result);
}
