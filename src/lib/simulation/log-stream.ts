import type { LogEntry, LogLevel, Service, ServiceStatus } from "@/lib/types";
import type { Rng } from "./noise";

/**
 * Ambient application log generator.
 *
 * The engine emits 2–4 lines per simulated second so /logs looks like a real
 * stream rather than a table that only fills up during a demo. Lines are drawn
 * from per-service templates and are shaped by the service's current status, so
 * a degraded or critical service produces WARN/ERROR bursts on its own —
 * scenario scripts still push their own narrative lines on top.
 *
 * Everything here is a pure function of (services, store state, rng): no
 * timers, no Date.now, no Math.random.
 */

/** Emitters the platform itself owns, alongside the application services. */
export const PLATFORM_SOURCES = ["anomaly-engine", "sentinel-autoheal"] as const;

/** Every source that can appear in the service filter, in display order. */
export function logSources(services: Service[]): string[] {
  return [...services.map((s) => s.id), ...PLATFORM_SOURCES];
}

type Template = (ctx: TemplateContext) => string;

interface TemplateContext {
  service: Service;
  rng: Rng;
}

/** Pick one of `list` uniformly. */
function pick<T>(list: readonly T[], rng: Rng): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const GET_ROUTES = [
  "/api/orders",
  "/api/orders/{id}",
  "/api/users/me",
  "/api/catalog/items",
  "/api/health",
] as const;

const POST_ROUTES = [
  "/api/orders",
  "/api/payments/authorize",
  "/api/auth/token",
  "/api/notifications/dispatch",
] as const;

function route(rng: Rng): { method: string; path: string } {
  return rng() < 0.7
    ? { method: "GET", path: pick(GET_ROUTES, rng) }
    : { method: "POST", path: pick(POST_ROUTES, rng) };
}

/** Healthy chatter, by service kind. */
const INFO_TEMPLATES: Record<string, Template[]> = {
  "api-gateway": [
    ({ rng }) => {
      const r = route(rng);
      return `Request completed ${r.method} ${r.path} 200 ${int(rng, 28, 180)}ms`;
    },
    ({ rng }) => `Upstream auth-service responded 200 in ${int(rng, 8, 42)}ms`,
    ({ rng }) => `Route table refreshed — ${int(rng, 18, 24)} routes active`,
    ({ rng }) => `Rate limiter bucket refilled for client ${int(rng, 1000, 9999)}`,
  ],
  "auth-service": [
    ({ rng }) => `Token issued for subject usr_${int(rng, 10000, 99999)} (ttl 900s)`,
    ({ rng }) => `JWT signature verified in ${int(rng, 1, 9)}ms`,
    ({ rng }) => `Session refreshed for usr_${int(rng, 10000, 99999)}`,
    ({ rng }) => `Password grant completed 200 ${int(rng, 30, 120)}ms`,
  ],
  "orders-service": [
    ({ rng }) => `Order ORD-${int(rng, 40000, 49999)} accepted (${int(rng, 1, 6)} items)`,
    ({ rng }) => `Enqueued payment job #${int(rng, 8000, 8999)} on queue payments`,
    ({ rng }) => `Inventory reservation committed in ${int(rng, 12, 90)}ms`,
    ({ rng }) => {
      const r = route(rng);
      return `Request completed ${r.method} ${r.path} 200 ${int(rng, 40, 240)}ms`;
    },
  ],
  "payment-worker": [
    ({ rng }) => `Processing payment job #${int(rng, 8000, 8999)}`,
    ({ rng }) => `Payment job #${int(rng, 8000, 8999)} settled in ${int(rng, 120, 640)}ms`,
    ({ rng }) => `Heap after GC ${int(rng, 38, 52)}% of container limit`,
    ({ rng }) => `Queue depth ${int(rng, 0, 14)} · consumers 4`,
  ],
  "notification-worker": [
    ({ rng }) => `Dispatched email notification #${int(rng, 5000, 5999)}`,
    ({ rng }) => `Webhook delivery accepted 202 in ${int(rng, 40, 210)}ms`,
    ({ rng }) => `Batch flushed — ${int(rng, 2, 18)} notifications`,
    ({ rng }) => `Template cache hit ratio ${int(rng, 92, 99)}%`,
  ],
  "redis-cache": [
    ({ rng }) => `Keyspace hit ratio ${int(rng, 93, 99)}.${int(rng, 0, 9)}%`,
    ({ rng }) => `Background RDB save completed in ${int(rng, 40, 260)}ms`,
    ({ rng }) => `Evicted ${int(rng, 0, 40)} keys under maxmemory-policy allkeys-lru`,
    ({ rng }) => `Connected clients ${int(rng, 18, 46)}`,
  ],
};

const DEBUG_TEMPLATES: Template[] = [
  ({ rng }) => `Connection pool 8/${int(rng, 10, 16)} in use`,
  ({ rng }) => `Trace span emitted (${int(rng, 3, 22)} children)`,
  ({ rng }) => `Config watcher poll — no change (rev ${int(rng, 40, 99)})`,
  ({ rng }) => `Heartbeat ack from supervisor in ${int(rng, 1, 6)}ms`,
];

/** Lines a service produces once it is degraded. */
const WARN_TEMPLATES: Template[] = [
  ({ rng }) => `Request latency above baseline — p95 ${int(rng, 480, 1400)}ms`,
  ({ rng }) => `Retrying upstream call (attempt ${int(rng, 2, 4)} of 4)`,
  ({ rng }) => `GC pause ${int(rng, 120, 680)}ms — heap not fully reclaimed`,
  ({ rng }) => `Connection pool saturated — ${int(rng, 1, 9)} requests queued`,
];

/** Lines a service produces once it is critical. */
const ERROR_TEMPLATES: Template[] = [
  ({ rng }) => `Upstream call failed after ${int(rng, 3, 4)} retries (deadline exceeded)`,
  ({ rng }) => `Request failed 500 — resource exhausted after ${int(rng, 200, 900)}ms`,
  ({ rng }) => `Job #${int(rng, 8000, 8999)} abandoned — worker unresponsive`,
  ({ rng }) => `Health probe failed (${int(rng, 1, 3)} consecutive)`,
];

function renderInfo(ctx: TemplateContext): string {
  const list = INFO_TEMPLATES[ctx.service.id];
  if (!list) return pick(DEBUG_TEMPLATES, ctx.rng)(ctx);
  return pick(list, ctx.rng)(ctx);
}

/**
 * Level mix for a service, by status. Healthy services are almost all
 * INFO/DEBUG; a critical service is mostly ERROR — the burst the operator
 * is meant to notice on /logs during a chaos run.
 */
function drawLevel(status: ServiceStatus, rng: Rng): LogLevel {
  const r = rng();
  switch (status) {
    case "critical":
      return r < 0.62 ? "ERROR" : r < 0.92 ? "WARN" : "INFO";
    case "degraded":
      return r < 0.52 ? "WARN" : r < 0.72 ? "ERROR" : "INFO";
    case "recovering":
      return r < 0.3 ? "WARN" : "INFO";
    default:
      return r < 0.22 ? "DEBUG" : "INFO";
  }
}

function renderMessage(
  level: LogLevel,
  ctx: TemplateContext,
): string {
  switch (level) {
    case "ERROR":
      return pick(ERROR_TEMPLATES, ctx.rng)(ctx);
    case "WARN":
      return pick(WARN_TEMPLATES, ctx.rng)(ctx);
    case "DEBUG":
      return pick(DEBUG_TEMPLATES, ctx.rng)(ctx);
    default:
      return renderInfo(ctx);
  }
}

export interface AmbientLogInput {
  services: Service[];
  /** Engine clock for this tick, ms. */
  now: number;
  /** Simulated ms this tick covers, so sub-second offsets stay inside it. */
  tickSpanMs: number;
  rng: Rng;
  /** Live anomaly score, for the anomaly-engine scan line. */
  anomalyScore: number;
  /** True while a remediation is executing — adds sentinel-autoheal lines. */
  remediating: boolean;
  /** Mint an id for each entry (the engine owns the sequence). */
  nextId: () => string;
}

/**
 * Draw this tick's ambient lines. Returns 2–4 application lines, plus an
 * anomaly-engine scan line roughly every few seconds and sentinel-autoheal
 * lines while an automatic action is in flight.
 */
export function ambientLogs(input: AmbientLogInput): LogEntry[] {
  const { services, now, tickSpanMs, rng, nextId } = input;
  if (services.length === 0) return [];

  const out: LogEntry[] = [];
  const stamp = () => now + Math.floor(rng() * Math.max(1, tickSpanMs));

  // Unhealthy services are noisier, which is what makes a chaos run visible in
  // the stream without any scripted line.
  const weighted: Service[] = [];
  for (const svc of services) {
    const weight = svc.status === "healthy" ? 1 : svc.status === "recovering" ? 2 : 3;
    for (let i = 0; i < weight; i += 1) weighted.push(svc);
  }

  const count = 2 + Math.floor(rng() * 3); // 2, 3 or 4
  for (let i = 0; i < count; i += 1) {
    const service = weighted[Math.floor(rng() * weighted.length)];
    const level = drawLevel(service.status, rng);
    out.push({
      id: nextId(),
      t: stamp(),
      level,
      service: service.id,
      message: renderMessage(level, { service, rng }),
    });
  }

  if (rng() < 0.25) {
    const abnormal = input.anomalyScore >= 0.7;
    out.push({
      id: nextId(),
      t: stamp(),
      level: abnormal ? "WARN" : "INFO",
      service: "anomaly-engine",
      message: abnormal
        ? `Abnormal score ${input.anomalyScore.toFixed(2)} across ${services.length} services — above decision threshold`
        : `Scored ${services.length} services · max anomaly score ${input.anomalyScore.toFixed(2)}`,
    });
  }

  if (input.remediating && rng() < 0.6) {
    out.push({
      id: nextId(),
      t: stamp(),
      level: "INFO",
      service: "sentinel-autoheal",
      message: pick(
        [
          "Remediation in progress — watching post-action telemetry",
          "Health verification pending",
          "Guardrail counters updated for the affected service",
        ] as const,
        rng,
      ),
    });
  }

  // Keep the batch in chronological order so the virtual list never jumps.
  return out.sort((a, b) => a.t - b.t);
}
