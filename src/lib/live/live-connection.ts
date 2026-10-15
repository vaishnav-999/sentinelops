import type { SentinelState } from "@/lib/store/sentinel-store";
import { CAPS, sentinelStore } from "@/lib/store/sentinel-store";
import { RING_SIZE } from "@/lib/mock-data/constants";
import { pushRing } from "@/lib/simulation/telemetry";
import { UnauthorizedError, apiFetch, setUnauthorizedHandler, wsUrl } from "@/lib/api/fetch";
import type { MetricSample, SentinelSettings } from "@/lib/types";

/**
 * Live mode transport. The FastAPI backend owns the state; this module mirrors
 * it into the Zustand store so every page renders exactly as it does on the
 * simulation, without knowing where the data came from.
 *
 *   snapshot  replaces every backend-owned key
 *   patch     `set` replaces keys that changed, `append` adds ring items
 *   notify    a toast
 */

export type LiveNotifier = (
  level: "success" | "info" | "warning" | "error",
  title: string,
  description?: string,
) => void;

/** Keys the backend owns. Anything else in the store stays client-side. */
const SET_KEYS = [
  "services",
  "cluster",
  "containers",
  "infraNodes",
  "infraEdges",
  "policies",
  "incidents",
  "executions",
  "selectedExecutionId",
  "anomaly",
  "diagnosis",
  "detectors",
  "islandState",
  "islandStartedAt",
  "islandChangedAt",
  "scenarioPhase",
  "activeScenario",
  "chaosRun",
  "settings",
  "guardrails",
  "experimentRuns",
  "research",
  "model",
  "backend",
] as const satisfies readonly (keyof SentinelState)[];

const RING_KEYS = {
  logs: CAPS.logs,
  events: CAPS.events,
  terminalLines: CAPS.terminal,
  clusterHistory: RING_SIZE,
  clusterTrail: CAPS.trail,
  anomalyHistory: CAPS.anomalyHistory,
} as const;

type RingKey = keyof typeof RING_KEYS;

interface PatchMessage {
  type: "patch";
  set: Partial<Record<string, unknown>>;
  append: Partial<Record<RingKey, unknown[]>> & {
    histories?: Record<string, MetricSample[]>;
  };
}

interface SnapshotMessage {
  type: "snapshot";
  state: Record<string, unknown> & { histories?: Record<string, MetricSample[]> };
}

interface NotifyMessage {
  type: "notify";
  level: Parameters<LiveNotifier>[0];
  title: string;
  description?: string | null;
}

type ServerMessage = PatchMessage | SnapshotMessage | NotifyMessage;

let socket: WebSocket | null = null;
let started = false;
let paused = false;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let notifier: LiveNotifier | null = null;
/** Settings as last confirmed by the backend, to avoid echoing them back. */
let serverSettings = "";

function stable(value: SentinelSettings): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}

function capList<T>(list: T[], n: number): T[] {
  return list.length > n ? list.slice(list.length - n) : list;
}

function pickSetKeys(source: Record<string, unknown>): Partial<SentinelState> {
  const next: Record<string, unknown> = {};
  for (const key of SET_KEYS) {
    if (key in source) next[key] = source[key];
  }
  const settings = next.settings as SentinelSettings | undefined;
  if (settings) serverSettings = stable(settings);
  return next as Partial<SentinelState>;
}

function applySnapshot(msg: SnapshotMessage): void {
  const next = pickSetKeys(msg.state) as Record<string, unknown>;
  for (const [key, cap] of Object.entries(RING_KEYS)) {
    const items = msg.state[key];
    if (Array.isArray(items)) next[key] = capList(items, cap);
  }
  const histories: Record<string, MetricSample[]> = {};
  for (const [id, samples] of Object.entries(msg.state.histories ?? {})) {
    histories[id] = capList(samples, RING_SIZE);
  }
  next.histories = histories;
  next.liveReady = true;
  sentinelStore.set(next as Partial<SentinelState>);
}

function applyPatch(msg: PatchMessage): void {
  sentinelStore.set((state) => {
    const next = pickSetKeys(msg.set as Record<string, unknown>) as Record<string, unknown>;
    for (const [key, cap] of Object.entries(RING_KEYS) as [RingKey, number][]) {
      const items = msg.append[key];
      if (items && items.length) {
        next[key] = capList([...(state[key] as unknown[]), ...items], cap);
      }
    }
    const hist = msg.append.histories;
    if (hist) {
      const histories = { ...state.histories };
      for (const [id, samples] of Object.entries(hist)) {
        let ring = histories[id] ?? [];
        for (const s of samples) ring = pushRing(ring, s, RING_SIZE);
        histories[id] = ring;
      }
      next.histories = histories;
    }
    return next as Partial<SentinelState>;
  });
}

function handle(raw: string): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    return;
  }
  if (msg.type === "notify") {
    notifier?.(msg.level, msg.title, msg.description ?? undefined);
    return;
  }
  if (msg.type === "snapshot") {
    applySnapshot(msg);
    return;
  }
  if (!paused) applyPatch(msg);
}

/** WebSocket close code the backend uses for a missing or expired session. */
const WS_UNAUTHORIZED = 4401;

function scheduleRetry(fn: () => void): void {
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, 8000);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(fn, wait);
}

function signedOut(): void {
  sentinelStore.set({ authState: "signed_out", authUser: null, liveReady: false });
  const ws = socket;
  socket = null;
  ws?.close();
}

function connect(): void {
  if (sentinelStore.get().authState === "signed_out") return;
  const ws = new WebSocket(wsUrl("/ws"));
  socket = ws;
  ws.onopen = () => {
    retryMs = 1000;
    sentinelStore.set({ connection: "ok" });
  };
  ws.onmessage = (event) => handle(String(event.data));
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    if (event.code === WS_UNAUTHORIZED) {
      signedOut();
      return;
    }
    sentinelStore.set({ connection: "lost" });
    scheduleRetry(connect);
  };
  ws.onerror = () => ws.close();
}

interface AuthInfo {
  user: string | null;
  authRequired: boolean;
}

/** Ask the backend who we are, then open the socket if allowed. */
async function authenticateThenConnect(): Promise<void> {
  try {
    const me = await apiFetch<AuthInfo>("GET", "/api/auth/me");
    sentinelStore.set({
      authState: me.authRequired ? "signed_in" : "disabled",
      authUser: me.user,
    });
    connect();
  } catch (error) {
    if (error instanceof UnauthorizedError) return;
    sentinelStore.set({ connection: "lost" });
    scheduleRetry(() => void authenticateThenConnect());
  }
}

const request = apiFetch;

function resync(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resync" }));
  }
}

/** Idempotent: StrictMode double-mounts reuse the one socket. */
export function startLive(notify: LiveNotifier): void {
  notifier = notify;
  if (started) return;
  started = true;
  sentinelStore.set({ live: true });
  setUnauthorizedHandler(signedOut);
  void authenticateThenConnect();

  // Settings edited on /settings are pushed to the backend, which owns them.
  sentinelStore.subscribe((state, prev) => {
    if (state.settings === prev.settings) return;
    const encoded = stable(state.settings);
    if (encoded === serverSettings) return;
    request<SentinelSettings>("POST", "/api/settings", state.settings)
      .then((saved) => {
        serverSettings = stable(saved);
      })
      .catch(() => {
        notifier?.("error", "Settings not saved", "The backend did not accept the change.");
        resync();
      });
  });
}

export function setLiveNotifier(notify: LiveNotifier | null): void {
  notifier = notify;
}

/** Freeze the console on its current values; the backend keeps working. */
export function pauseLive(): void {
  paused = true;
  sentinelStore.set({ live: false });
}

export function resumeLive(): void {
  paused = false;
  sentinelStore.set({ live: true });
  resync();
}

/** Throws with the backend's message (wrong password, rate limited, …). */
export async function loginLive(username: string, password: string): Promise<void> {
  const res = await apiFetch<AuthInfo>("POST", "/api/auth/login", { username, password });
  retryMs = 1000;
  sentinelStore.set({ authState: "signed_in", authUser: res.user });
  connect();
}

export async function logoutLive(): Promise<void> {
  try {
    await apiFetch("POST", "/api/auth/logout");
  } finally {
    signedOut();
  }
}

/** Revert every injected fault, remove replicas, restart stopped containers. */
export async function resetLive(): Promise<void> {
  try {
    await request("POST", "/api/system/reset");
  } catch {
    notifier?.("error", "Reset failed", "The backend could not be reached.");
  }
}
