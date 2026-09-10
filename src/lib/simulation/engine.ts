import type {
  DetectorResult,
  EventKind,
  ExperimentRun,
  LogEntry,
  LogLevel,
  ScenarioId,
  Service,
  ServiceMetrics,
  Severity,
  SystemEvent,
  TerminalLevel,
  TerminalLine,
} from "@/lib/types";
import { CAPS, sentinelStore } from "@/lib/store/sentinel-store";
import { RING_SIZE } from "@/lib/mock-data";
import { createRng, type Rng } from "./noise";
import {
  aggregateCluster,
  pushRing,
  sampleFromMetrics,
  tickServiceMetrics,
} from "./telemetry";
import {
  ScenarioRun,
  type ScenarioContext,
  type ScenarioDefinition,
} from "./scenario-runner";
import { memoryLeakScenario } from "./scenarios/memory-leak";
import { unknownAnomalyScenario } from "./scenarios/unknown-anomaly";

export interface EngineOptions {
  /** Real interval between ticks, ms. */
  tickMs?: number;
  /** Simulated time advanced per tick = tickMs · timeScale. >1 = faster demo. */
  timeScale?: number;
  /** PRNG seed (kept fixed so runs are reproducible). */
  seed?: number;
}

const SCENARIOS: Record<string, ScenarioDefinition> = {
  [memoryLeakScenario.id]: memoryLeakScenario,
  [unknownAnomalyScenario.id]: unknownAnomalyScenario,
};

/** Ticks between coarse-trail samples: 5 s × CAPS.trail ≈ a 5-minute window. */
const TRAIL_INTERVAL_TICKS = 5;

/** Idle-event spacing in simulated ms — calm, not one per tick (SPEC §8). */
const CALM_EVENT_MIN_MS = 4000;
const CALM_EVENT_JITTER_MS = 2000;

/** Keep only the most recent `n` items of a list. */
function cap<T>(list: T[], n: number): T[] {
  return list.length > n ? list.slice(list.length - n) : list;
}

/**
 * The simulation engine: the single owner of the telemetry timer. Everything
 * it changes flows through the store, so every page updates live. It is a
 * module-level singleton and `start()` is idempotent, which makes it safe under
 * React StrictMode's double-mount.
 */
export class SimulationEngine {
  private tickMs: number;
  private timeScale: number;
  private rng: Rng;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private paused = false;

  /** Simulated epoch-ms clock; advances by tickMs·timeScale each active tick. */
  private clock = 0;
  private seq = 0;
  private ticks = 0;
  /** Engine clock the next calm idle event is due; 0 = due immediately. */
  private nextCalmEventAt = 0;
  private calmIndex = 0;

  /** Per-service walk targets (the mean the noise reverts toward). */
  private targets: Record<string, ServiceMetrics> = {};

  private run: ScenarioRun | null = null;
  private runStartClock = 0;
  private experimentId: string | null = null;
  /** Engine clock when island entered `recovered`; cleared on other states. */
  private recoveredSince: number | null = null;

  constructor(opts: EngineOptions = {}) {
    this.tickMs = opts.tickMs ?? 1000;
    this.timeScale = opts.timeScale ?? 1;
    this.rng = createRng(opts.seed ?? 0x5e17);
    this.seedTargets();
  }

  /* ----------------------------- lifecycle ----------------------------- */

  start(): void {
    // Always unpause and mark LIVE. The early-return used to skip this when
    // the singleton was already `running` (HMR / StrictMode), which left a
    // previously paused engine showing PAUSED on the next first paint.
    this.paused = false;
    if (!this.running) {
      this.running = true;
      this.clock = Date.now(); // client-only; safe after mount
      this.timer = setInterval(() => this.tick(), this.tickMs);
    }
    sentinelStore.set({ live: true, connection: "ok" });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  pause(): void {
    this.paused = true;
    sentinelStore.set({ live: false });
  }

  resume(): void {
    this.paused = false;
    sentinelStore.set({ live: true });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Reconfigure timing (e.g. a fast test script). Safe while running. */
  configure(opts: EngineOptions): void {
    if (opts.tickMs !== undefined) this.tickMs = opts.tickMs;
    if (opts.timeScale !== undefined) this.timeScale = opts.timeScale;
    if (opts.seed !== undefined) this.rng = createRng(opts.seed);
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  /* ---------------------------- scenarios ------------------------------ */

  runScenario(id: ScenarioId): void {
    const def = SCENARIOS[id];
    if (!def) {
      // Not yet choreographed — no-op rather than throw (keeps demo stable).
      return;
    }
    // Cancel any in-flight run first: re-running or resetting mid-run is clean.
    if (this.run) this.run.cancel();

    this.run = new ScenarioRun(def, this.buildContext());
    this.runStartClock = this.clock;

    const experiment: ExperimentRun = {
      id: this.nextId("EXP"),
      scenarioId: def.id,
      faultType: def.faultType,
      target: def.target,
      injectedAt: this.clock,
      thresholdDetectedAt: null,
      mlDetectedAt: null,
      remediatedAt: null,
      outcome: "running",
    };
    this.experimentId = experiment.id;

    sentinelStore.set((s) => ({
      activeScenario: def.id,
      scenarioPhase: "injecting",
      experimentRuns: cap([...s.experimentRuns, experiment], 100),
    }));
  }

  /** Restore the exact seeded healthy state; cancels any running scenario. */
  reset(): void {
    if (this.run) this.run.cancel();
    this.run = null;
    this.experimentId = null;
    this.recoveredSince = null;
    this.nextCalmEventAt = 0;
    this.calmIndex = 0;
    sentinelStore.get().reset();
    this.seedTargets();
  }

  /* ------------------------------ tick --------------------------------- */

  private tick(): void {
    if (!this.running || this.paused) return;

    // A simulated telemetry outage freezes the whole simulation, which is what
    // makes "showing last known values" literally true (SPEC §25).
    if (sentinelStore.get().connection === "lost") return;

    this.clock += this.tickMs * this.timeScale;
    this.ticks += 1;

    // 1) Advance the active scenario (may shift targets / statuses).
    if (this.run) {
      const done = this.run.advance(this.clock - this.runStartClock);
      if (done) this.finalizeScenario();
    }

    const state = sentinelStore.get();

    // 2) Walk each service's metrics toward its current target.
    const services = state.services.map((svc) => {
      const target = this.targets[svc.id] ?? svc.baseline;
      return { ...svc, metrics: tickServiceMetrics(svc.metrics, target, this.rng) };
    });

    // 3) Append to per-service ring buffers.
    const histories: typeof state.histories = {};
    for (const svc of services) {
      const prev = state.histories[svc.id] ?? [];
      histories[svc.id] = pushRing(prev, sampleFromMetrics(this.clock, svc.metrics), RING_SIZE);
    }

    // 4) Aggregate the cluster + append cluster ring buffer.
    const criticalIncidents = state.incidents.filter(
      (i) => i.status !== "resolved" && i.status !== "escalated",
    ).length;
    const cluster = aggregateCluster(this.clock, services, criticalIncidents);
    const clusterHistory = pushRing(state.clusterHistory, cluster, RING_SIZE);

    sentinelStore.set({ services, histories, cluster, clusterHistory });

    // 4b) Coarse trail, sampled every few ticks, backs the "vs 5 min ago" deltas.
    if (this.ticks % TRAIL_INTERVAL_TICKS === 0) {
      sentinelStore.set((s) => ({
        clusterTrail: pushRing(s.clusterTrail, cluster, CAPS.trail),
      }));
    }

    // 5) Status island returns to operational 8s after recovered (SPEC §19).
    if (this.recoveredSince !== null && this.clock - this.recoveredSince >= 8000) {
      this.recoveredSince = null;
      sentinelStore.set({
        islandState: "operational",
        islandStartedAt: null,
        islandChangedAt: this.clock,
      });
    }

    // 6) Calm idle chatter so the live stream breathes without spamming a line
    //     per tick. Scenarios narrate themselves, so stay quiet during a run.
    if (!this.run && this.clock >= this.nextCalmEventAt) {
      this.pushCalmEvent(services);
      this.nextCalmEventAt =
        this.clock + CALM_EVENT_MIN_MS + Math.floor(this.rng() * CALM_EVENT_JITTER_MS);
    }
  }

  /**
   * One rotating "nothing is wrong" event: telemetry batch, health check,
   * anomaly scan, container heartbeat (SPEC §8).
   */
  private pushCalmEvent(services: Service[]): void {
    const svc = services[this.calmIndex % services.length];
    const slot = this.calmIndex % 4;
    this.calmIndex += 1;

    switch (slot) {
      case 0:
        this.pushEvent(
          "telemetry",
          `Telemetry batch received — ${services.length} services`,
          { severity: "info" },
        );
        return;
      case 1:
        this.pushEvent("health", `Health check passed — ${svc.id}`, {
          severity: "ok",
          serviceId: svc.id,
        });
        return;
      case 2: {
        const score = sentinelStore.get().anomaly.score;
        this.pushEvent(
          "anomaly",
          `Anomaly scan completed — score ${score.toFixed(2)}`,
          { severity: "info" },
        );
        return;
      }
      default:
        this.pushEvent("info", `Container heartbeat — ${svc.containerId}`, {
          severity: "info",
          serviceId: svc.id,
        });
    }
  }

  private finalizeScenario(): void {
    const phase = sentinelStore.get().scenarioPhase;
    const outcome: ExperimentRun["outcome"] =
      phase === "escalated" ? "escalated" : "auto_healed";

    if (this.experimentId) {
      const id = this.experimentId;
      sentinelStore.set((s) => ({
        experimentRuns: s.experimentRuns.map((e) =>
          e.id === id
            ? {
                ...e,
                outcome,
                remediatedAt: outcome === "auto_healed" ? this.clock : e.remediatedAt,
              }
            : e,
        ),
      }));
    }

    this.run = null;
    this.experimentId = null;
    sentinelStore.set({ activeScenario: null });
  }

  /* ---------------------------- internals ------------------------------ */

  private seedTargets(): void {
    this.targets = {};
    for (const svc of sentinelStore.get().services) {
      this.targets[svc.id] = { ...svc.baseline };
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private pushEvent(
    kind: EventKind,
    message: string,
    opts?: { severity?: Severity; serviceId?: string },
  ): void {
    const event: SystemEvent = {
      id: this.nextId("evt"),
      t: this.clock,
      kind,
      message,
      severity: opts?.severity ?? "info",
      serviceId: opts?.serviceId,
    };
    sentinelStore.set((s) => ({ events: cap([...s.events, event], CAPS.events) }));
  }

  private pushTerminal(text: string, level: TerminalLevel = "info"): void {
    const line: TerminalLine = { id: this.nextId("term"), t: this.clock, text, level };
    sentinelStore.set((s) => ({
      terminalLines: cap([...s.terminalLines, line], CAPS.terminal),
    }));
  }

  private pushLog(level: LogLevel, service: string, message: string): void {
    const entry: LogEntry = { id: this.nextId("log"), t: this.clock, level, service, message };
    sentinelStore.set((s) => ({ logs: cap([...s.logs, entry], CAPS.logs) }));
  }

  private recordDetection(kind: DetectorResult["kind"], firedAt: number | null): void {
    if (!this.experimentId || firedAt === null) return;
    const id = this.experimentId;
    sentinelStore.set((s) => ({
      experimentRuns: s.experimentRuns.map((e) => {
        if (e.id !== id) return e;
        if (kind === "threshold" && e.thresholdDetectedAt === null) {
          return { ...e, thresholdDetectedAt: firedAt };
        }
        if (kind === "ml" && e.mlDetectedAt === null) {
          return { ...e, mlDetectedAt: firedAt };
        }
        return e;
      }),
    }));
  }

  /** Bind the scenario surface to this engine + the store. */
  private buildContext(): ScenarioContext {
    return {
      now: () => this.clock,
      setPhase: (scenarioPhase) => sentinelStore.set({ scenarioPhase }),
      setIsland: (islandState) => {
        const prev = sentinelStore.get();
        const now = this.clock;
        const leavingHealthy =
          prev.islandState === "operational" && islandState !== "operational";
        const islandStartedAt =
          islandState === "operational"
            ? null
            : leavingHealthy || prev.islandStartedAt === null
              ? now
              : prev.islandStartedAt;
        this.recoveredSince = islandState === "recovered" ? now : null;
        sentinelStore.set({
          islandState,
          islandStartedAt,
          islandChangedAt: now,
        });
      },
      setServiceTarget: (serviceId, patch) => {
        const base = this.targets[serviceId] ??
          sentinelStore.get().services.find((s) => s.id === serviceId)?.baseline;
        if (base) this.targets[serviceId] = { ...base, ...patch };
      },
      resetServiceTarget: (serviceId) => {
        const svc = sentinelStore.get().services.find((s) => s.id === serviceId);
        if (svc) this.targets[serviceId] = { ...svc.baseline };
      },
      setServiceStatus: (serviceId, status) =>
        sentinelStore.set((s) => ({
          services: s.services.map((x) => (x.id === serviceId ? { ...x, status } : x)),
        })),
      setAnomaly: (patch) =>
        sentinelStore.set((s) => ({ anomaly: { ...s.anomaly, ...patch } })),
      setDetector: (kind, patch) => {
        sentinelStore.set((s) => ({
          detectors: s.detectors.map((d) => (d.kind === kind ? { ...d, ...patch } : d)),
        }));
        if (patch.fired && patch.firedAt !== undefined) {
          this.recordDetection(kind, patch.firedAt);
        }
      },
      setDiagnosis: (diagnosis) => sentinelStore.set({ diagnosis }),
      pushEvent: (kind, message, opts) => this.pushEvent(kind, message, opts),
      pushTerminal: (text, level) => this.pushTerminal(text, level),
      log: (level, service, message) => this.pushLog(level, service, message),
    };
  }
}

/**
 * Module-level singleton. Importing this module more than once (or mounting the
 * provider twice under StrictMode) reuses the same engine and the same timer.
 */
export const engine = new SimulationEngine();
