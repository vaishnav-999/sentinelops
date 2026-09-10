import type {
  ChaosRunState,
  ContainerStatus,
  DetectorResult,
  EventKind,
  ExperimentRun,
  Incident,
  IncidentStage,
  LogEntry,
  LogLevel,
  RunStepId,
  RunStepRecord,
  ScenarioId,
  ScenarioPhase,
  Service,
  ServiceMetrics,
  Severity,
  StageRecord,
  StageStatus,
  SystemEvent,
  TerminalLevel,
  TerminalLine,
} from "@/lib/types";
import { CAPS, sentinelStore } from "@/lib/store/sentinel-store";
import { NEXT_INCIDENT_SEQ, RING_SIZE, SEED_NOW } from "@/lib/mock-data";
import { createRng, round, type Rng } from "./noise";
import {
  jitteredTiming,
  nominalTiming,
  scenarioTiming,
  warpFactors,
  type RunTiming,
} from "./timing";
import {
  aggregateCluster,
  pushRing,
  sampleFromMetrics,
  tickServiceMetrics,
} from "./telemetry";
import {
  ScenarioRun,
  type NotifyLevel,
  type OpenIncidentInput,
  type ScenarioContext,
  type ScenarioDefinition,
} from "./scenario-runner";
import { memoryLeakScenario } from "./scenarios/memory-leak";
import { unknownAnomalyScenario } from "./scenarios/unknown-anomaly";
import {
  cacheSaturationScenario,
  cpuSpikeScenario,
  latencyInjectionScenario,
  serviceCrashScenario,
} from "./scenarios/standard";

export interface EngineOptions {
  /** Real interval between ticks, ms. */
  tickMs?: number;
  /** Simulated time advanced per tick = tickMs · timeScale. >1 = faster demo. */
  timeScale?: number;
  /** PRNG seed (kept fixed so runs are reproducible). */
  seed?: number;
}

/** Toast sink. Registered by the client provider; a no-op on the server. */
export type EngineNotifier = (
  level: NotifyLevel,
  title: string,
  description?: string,
) => void;

const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = {
  "memory-leak": memoryLeakScenario,
  "unknown-anomaly": unknownAnomalyScenario,
  "cpu-spike": cpuSpikeScenario,
  "service-crash": serviceCrashScenario,
  "latency-injection": latencyInjectionScenario,
  "cache-saturation": cacheSaturationScenario,
};

export function getScenario(id: ScenarioId): ScenarioDefinition | undefined {
  return SCENARIOS[id];
}

/** Ticks between coarse-trail samples: 5 s × CAPS.trail ≈ a 5-minute window. */
const TRAIL_INTERVAL_TICKS = 5;

/** Idle-event spacing in simulated ms — calm, not one per tick (SPEC §8). */
const CALM_EVENT_MIN_MS = 4000;
const CALM_EVENT_JITTER_MS = 2000;

/** 3 · 2 · 1 before the fault lands (SPEC §13). */
export const COUNTDOWN_MS = 3000;

/** Run-console stepper order; the last node depends on the outcome. */
const AUTO_HEAL_STEPS: RunStepId[] = [
  "injected",
  "detected",
  "analyzing",
  "policy_check",
  "remediating",
  "verifying",
  "resolved",
];

const ESCALATE_STEPS: RunStepId[] = [
  "injected",
  "detected",
  "analyzing",
  "policy_check",
  "escalated",
];

/** One run-console step maps to exactly one scenario phase. */
const STEP_PHASE: Record<RunStepId, ScenarioPhase> = {
  injected: "injecting",
  detected: "detected",
  analyzing: "diagnosing",
  policy_check: "policy_check",
  remediating: "remediating",
  verifying: "verifying",
  resolved: "resolved",
  escalated: "escalated",
};

/** Keep only the most recent `n` items of a list. */
function cap<T>(list: T[], n: number): T[] {
  return list.length > n ? list.slice(list.length - n) : list;
}

/** The six-stage incident timeline, all pending. */
function pendingStages(): StageRecord[] {
  return (
    [
      "detected",
      "analyzed",
      "policy_check",
      "remediation",
      "verification",
      "resolved",
    ] as IncidentStage[]
  ).map((stage) => ({ stage, status: "pending" as StageStatus }));
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
  private incidentSeq = NEXT_INCIDENT_SEQ;
  private ticks = 0;
  /** Engine clock the next calm idle event is due; 0 = due immediately. */
  private nextCalmEventAt = 0;
  private calmIndex = 0;

  /** Per-service walk targets (the mean the noise reverts toward). */
  private targets: Record<string, ServiceMetrics> = {};

  private run: ScenarioRun | null = null;
  /** The timing this run was minted with; every quoted duration reads it. */
  private runTiming: RunTiming = nominalTiming();
  /**
   * Runs since page load / Reset Demo. Run #1 uses the baseline timing exactly
   * so the walkthrough matches the slides; later runs are drawn.
   */
  private runsSinceReset = 0;
  /**
   * Engine clock before which the static threshold rule may not fire, even
   * with the metric over the line: its evaluation interval + hold-down.
   */
  private thresholdArmAt = 0;
  /** Engine clock the fault lands — the countdown runs before this. */
  private runStartClock = 0;
  private injected = false;
  private experimentId: string | null = null;
  /**
   * Scheduled offset of the step currently executing, so `ctx.now()` reports
   * choreographed time rather than tick-quantised time. Null between steps.
   */
  private stepAtMs: number | null = null;
  /** Engine clock when island entered `recovered`; cleared on other states. */
  private recoveredSince: number | null = null;

  private notifier: EngineNotifier | null = null;
  private readonly ctx: ScenarioContext;

  constructor(opts: EngineOptions = {}) {
    this.tickMs = opts.tickMs ?? 1000;
    this.timeScale = opts.timeScale ?? 1;
    this.rng = createRng(opts.seed ?? 0x5e17);
    this.ctx = this.buildContext();
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
      this.rebaseSeedIncidents();
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

  /** True while a scenario is counting down or playing. */
  get hasActiveRun(): boolean {
    return this.run !== null;
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

  /** Register the toast sink (client only). Pass null to detach. */
  setNotifier(notifier: EngineNotifier | null): void {
    this.notifier = notifier;
  }

  /* ---------------------------- scenarios ------------------------------ */

  /**
   * Start a chaos scenario. Every trigger — a Chaos Lab button, Shift+D, the
   * command palette, `api.injectChaos` — lands here, so there is exactly one
   * code path and one set of timers.
   */
  runScenario(id: ScenarioId): void {
    const def = SCENARIOS[id];
    if (!def) return; // Unknown id: no-op rather than throw (keeps demo stable).

    // Cancel any in-flight run first: re-running or resetting mid-run is clean.
    this.cancelRun("cancelled");

    // Run #1 after load/reset is the slide-exact one; the rest vary.
    const drawn =
      this.runsSinceReset === 0 ? nominalTiming() : jitteredTiming(this.rng);
    this.runsSinceReset += 1;
    const warp = warpFactors(drawn);
    this.runTiming = scenarioTiming(def.nominal, warp, drawn.thresholdDelaySec);

    this.run = new ScenarioRun(def, this.ctx, warp);
    // The fault lands after the 3-2-1 countdown; elapsed time is measured from
    // injection, so every choreographed offset is countdown-independent.
    this.runStartClock = this.clock + COUNTDOWN_MS;
    this.thresholdArmAt =
      this.runStartClock +
      (this.runTiming.mlDetectSec + this.runTiming.thresholdDelaySec) * 1000;
    this.injected = false;

    const experiment: ExperimentRun = {
      id: this.nextId("EXP"),
      scenarioId: def.id,
      faultType: def.faultType,
      target: def.target,
      injectedAt: this.runStartClock,
      thresholdDetectedAt: null,
      mlDetectedAt: null,
      remediatedAt: null,
      outcome: "running",
    };
    this.experimentId = experiment.id;

    const steps: RunStepRecord[] = (
      def.expected === "escalate" ? ESCALATE_STEPS : AUTO_HEAL_STEPS
    ).map((s) => ({ id: s, at: null }));

    const chaosRun: ChaosRunState = {
      runId: experiment.id,
      scenarioId: def.id,
      title: def.title,
      target: def.target,
      metric: def.metric,
      threshold: def.threshold,
      thresholdLabel: def.thresholdLabel,
      requestedAt: this.clock,
      injectedAt: null,
      countdown: Math.ceil(COUNTDOWN_MS / 1000),
      steps,
      current: null,
      incidentId: null,
      diagnosisNote: null,
      policyNote: null,
      healthChecks: [],
      action: null,
      outcome: "running",
      finishedAt: null,
      mlDetectedSec: null,
      thresholdDetectedSec: null,
      recoverySec: null,
    };

    sentinelStore.set((s) => ({
      activeScenario: def.id,
      scenarioPhase: "injecting",
      chaosRun,
      experimentRuns: cap([...s.experimentRuns, experiment], 100),
      // Each run starts from a clean detector pair, so back-to-back runs never
      // inherit the previous run's "fired" state.
      detectors: s.detectors.map((d) =>
        d.kind === "threshold"
          ? {
              ...d,
              fired: false,
              firedAt: null,
              value: def.threshold,
              detail: def.thresholdLabel,
            }
          : { ...d, fired: false, firedAt: null, value: 0.08 },
      ),
    }));
  }

  /** Restore the exact seeded healthy state; cancels any running scenario. */
  reset(): void {
    this.cancelRun("cancelled");

    // Experiment history is research output — it survives a demo reset.
    const runs = sentinelStore.get().experimentRuns;

    this.recoveredSince = null;
    this.nextCalmEventAt = 0;
    this.calmIndex = 0;
    this.ticks = 0;
    this.seq = 0;
    this.incidentSeq = NEXT_INCIDENT_SEQ;
    this.stepAtMs = null;
    this.runsSinceReset = 0;
    this.runTiming = nominalTiming();

    sentinelStore.get().reset();
    sentinelStore.set({ experimentRuns: runs, live: true, connection: "ok" });
    this.rebaseSeedIncidents();
    this.seedTargets();
  }

  /**
   * Seed timestamps hang off the fixed `SEED_NOW` anchor so the server and the
   * client render the same HTML. Once the engine has a real clock, shift the
   * historical incidents onto it, so "3 hours ago" stays true on any date.
   * Idempotent: it only ever touches incidents that came from the seed.
   */
  private rebaseSeedIncidents(): void {
    if (!this.running) return; // no real clock yet — nothing to rebase onto
    const shift = this.clock - SEED_NOW;
    if (shift === 0) return;
    sentinelStore.set((s) => ({
      incidents: s.incidents.map((inc) =>
        inc.scenarioId !== undefined
          ? inc
          : {
              ...inc,
              detectedAt: inc.detectedAt + shift,
              resolvedAt:
                inc.resolvedAt === undefined ? undefined : inc.resolvedAt + shift,
              stages: inc.stages.map((st) =>
                st.at === undefined ? st : { ...st, at: st.at + shift },
              ),
            },
      ),
    }));
  }

  /** Cancel the in-flight run (if any) and close out its experiment row. */
  private cancelRun(outcome: "cancelled"): void {
    if (!this.run) return;
    this.run.cancel();
    this.run = null;
    this.injected = false;

    const id = this.experimentId;
    this.experimentId = null;
    if (id) {
      sentinelStore.set((s) => ({
        experimentRuns: s.experimentRuns.map((e) =>
          e.id === id && e.outcome === "running" ? { ...e, outcome } : e,
        ),
        chaosRun:
          s.chaosRun && s.chaosRun.runId === id
            ? { ...s.chaosRun, outcome, finishedAt: this.clock, current: null }
            : s.chaosRun,
      }));
    }
    sentinelStore.set({ activeScenario: null, scenarioPhase: "idle" });
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
      if (!this.injected && this.clock < this.runStartClock) {
        this.tickCountdown();
      } else {
        if (!this.injected) this.beginInjection();
        const done = this.run.advance(this.clock - this.runStartClock);
        if (done) this.finalizeScenario();
      }
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

    // 4c) The static rule is evaluated against live telemetry, not scripted:
    //     it fires only once the metric genuinely crosses its threshold, which
    //     is the whole point of showing it beside the anomaly detector.
    this.evaluateThreshold(services);

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

  /** 3 → 2 → 1 in the run console while the fault is pending. */
  private tickCountdown(): void {
    const remaining = Math.max(
      1,
      Math.ceil((this.runStartClock - this.clock) / 1000),
    );
    const current = sentinelStore.get().chaosRun;
    if (current && current.countdown !== remaining) {
      sentinelStore.set({ chaosRun: { ...current, countdown: remaining } });
    }
  }

  /** The moment the fault lands: stamp the console and narrate it. */
  private beginInjection(): void {
    this.injected = true;
    const def = this.run?.def;
    this.patchRun({ countdown: null, injectedAt: this.runStartClock });
    if (def) {
      this.pushEvent("incident", `Fault injected — ${def.title} on ${def.target}`, {
        severity: "warn",
        serviceId: def.target,
      });
    }
  }

  private evaluateThreshold(services: Service[]): void {
    if (!this.run || !this.injected) return;
    const def = this.run.def;
    const detector = sentinelStore
      .get()
      .detectors.find((d) => d.kind === "threshold");
    if (!detector || detector.fired) return;

    // A static rule is not instantaneous: it evaluates on an interval and holds
    // the condition down before alerting. `thresholdArmAt` is that wait, so the
    // rule confirms a few seconds behind the detector — the comparison the
    // research question is about — while still needing a genuine breach.
    if (this.clock < this.thresholdArmAt) return;

    const svc = services.find((s) => s.id === def.target);
    if (!svc || svc.metrics[def.metric] <= def.threshold) return;

    this.setDetector("threshold", {
      fired: true,
      firedAt: this.clock,
      value: def.threshold,
      detail: def.thresholdLabel,
    });
    this.pushEvent("anomaly", `Threshold rule fired — ${def.thresholdLabel}`, {
      severity: "warn",
      serviceId: def.target,
    });
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
    const state = sentinelStore.get();
    const phase = state.scenarioPhase;
    const outcome: ExperimentRun["outcome"] =
      phase === "escalated" ? "escalated" : "auto_healed";

    if (this.experimentId) {
      const id = this.experimentId;
      const remediatedAt =
        state.chaosRun?.steps.find((s) => s.id === "resolved")?.at ?? null;
      sentinelStore.set((s) => ({
        experimentRuns: s.experimentRuns.map((e) =>
          e.id === id
            ? {
                ...e,
                outcome,
                remediatedAt:
                  outcome === "auto_healed" ? remediatedAt : e.remediatedAt,
              }
            : e,
        ),
      }));
    }

    this.patchRun({
      outcome: outcome === "escalated" ? "escalated" : "auto_healed",
      finishedAt: this.clock,
      current: null,
    });

    this.run = null;
    this.injected = false;
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

  /** Scheduled step time while a step runs, tick time otherwise. */
  private stepNow(): number {
    return this.stepAtMs === null ? this.clock : this.runStartClock + this.stepAtMs;
  }

  private patchRun(patch: Partial<ChaosRunState>): void {
    sentinelStore.set((s) =>
      s.chaosRun ? { chaosRun: { ...s.chaosRun, ...patch } } : {},
    );
  }

  private pushEvent(
    kind: EventKind,
    message: string,
    opts?: { severity?: Severity; serviceId?: string },
  ): void {
    const event: SystemEvent = {
      id: this.nextId("evt"),
      t: this.stepNow(),
      kind,
      message,
      severity: opts?.severity ?? "info",
      serviceId: opts?.serviceId,
    };
    sentinelStore.set((s) => ({ events: cap([...s.events, event], CAPS.events) }));
  }

  private pushTerminal(text: string, level: TerminalLevel = "info"): void {
    const line: TerminalLine = {
      id: this.nextId("term"),
      t: this.stepNow(),
      text,
      level,
    };
    sentinelStore.set((s) => ({
      terminalLines: cap([...s.terminalLines, line], CAPS.terminal),
    }));
  }

  private pushLog(level: LogLevel, service: string, message: string): void {
    const entry: LogEntry = {
      id: this.nextId("log"),
      t: this.stepNow(),
      level,
      service,
      message,
    };
    sentinelStore.set((s) => ({ logs: cap([...s.logs, entry], CAPS.logs) }));
  }

  private setDetector(
    kind: DetectorResult["kind"],
    patch: Partial<DetectorResult>,
  ): void {
    sentinelStore.set((s) => ({
      detectors: s.detectors.map((d) => (d.kind === kind ? { ...d, ...patch } : d)),
    }));
    if (patch.fired && patch.firedAt != null) {
      this.recordDetection(kind, patch.firedAt);
    }
  }

  private recordDetection(kind: DetectorResult["kind"], firedAt: number): void {
    const id = this.experimentId;
    const injectedAt = this.runStartClock;
    const seconds = Math.max(0, (firedAt - injectedAt) / 1000);

    if (id) {
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
    this.patchRun(
      kind === "threshold"
        ? { thresholdDetectedSec: Math.round(seconds * 10) / 10 }
        : { mlDetectedSec: Math.round(seconds * 10) / 10 },
    );
  }

  private setStage(
    incidentId: string,
    stage: IncidentStage,
    status: StageStatus,
    detail?: string,
  ): void {
    const at = this.stepNow();
    sentinelStore.set((s) => ({
      incidents: s.incidents.map((inc) => {
        if (inc.id !== incidentId) return inc;
        const known = inc.stages.some((x) => x.stage === stage);
        const stages = known
          ? inc.stages.map((x) =>
              x.stage === stage ? { ...x, status, at, detail: detail ?? x.detail } : x,
            )
          : [...inc.stages, { stage, status, at, detail }];
        return { ...inc, stages };
      }),
    }));
  }

  /** Bind the scenario surface to this engine + the store. */
  private buildContext(): ScenarioContext {
    return {
      timing: () => this.runTiming,
      now: () => this.stepNow(),
      mark: (atMs) => {
        this.stepAtMs = atMs;
      },
      setPhase: (scenarioPhase) => sentinelStore.set({ scenarioPhase }),
      step: (id) => {
        sentinelStore.set((s) => ({
          scenarioPhase: STEP_PHASE[id],
          chaosRun: s.chaosRun
            ? {
                ...s.chaosRun,
                current: id,
                steps: s.chaosRun.steps.map((x) =>
                  x.id === id && x.at === null ? { ...x, at: this.stepNow() } : x,
                ),
              }
            : s.chaosRun,
        }));
      },
      runConsole: (patch) => this.patchRun(patch),
      healthCheck: (text) =>
        sentinelStore.set((s) =>
          s.chaosRun
            ? { chaosRun: { ...s.chaosRun, healthChecks: [...s.chaosRun.healthChecks, text] } }
            : {},
        ),
      setIsland: (islandState) => {
        const prev = sentinelStore.get();
        const now = this.stepNow();
        const leavingHealthy =
          prev.islandState === "operational" && islandState !== "operational";
        const islandStartedAt =
          islandState === "operational"
            ? null
            : leavingHealthy || prev.islandStartedAt === null
              ? now
              : prev.islandStartedAt;
        this.recoveredSince = islandState === "recovered" ? this.clock : null;
        sentinelStore.set({
          islandState,
          islandStartedAt,
          islandChangedAt: now,
        });
      },
      setServiceTarget: (serviceId, patch) => {
        const base =
          this.targets[serviceId] ??
          sentinelStore.get().services.find((s) => s.id === serviceId)?.baseline;
        if (base) this.targets[serviceId] = { ...base, ...patch };
      },
      setServiceMetrics: (serviceId, patch) => {
        const base =
          this.targets[serviceId] ??
          sentinelStore.get().services.find((s) => s.id === serviceId)?.baseline;
        if (base) this.targets[serviceId] = { ...base, ...patch };
        sentinelStore.set((s) => ({
          services: s.services.map((x) =>
            x.id === serviceId ? { ...x, metrics: { ...x.metrics, ...patch } } : x,
          ),
        }));
      },
      snapshot: (serviceId) => {
        const m = sentinelStore.get().services.find((s) => s.id === serviceId)
          ?.metrics;
        if (!m) return {};
        return {
          cpu: round(m.cpu),
          memory: round(m.memory),
          latencyP95: Math.round(m.latencyP95),
          errorRate: round(m.errorRate, 2),
          ...(m.hitRate === undefined ? {} : { hitRate: round(m.hitRate) }),
        };
      },
      resetServiceTarget: (serviceId) => {
        const svc = sentinelStore.get().services.find((s) => s.id === serviceId);
        if (svc) this.targets[serviceId] = { ...svc.baseline };
      },
      setServiceStatus: (serviceId, status) =>
        sentinelStore.set((s) => ({
          services: s.services.map((x) => (x.id === serviceId ? { ...x, status } : x)),
          infraNodes: s.infraNodes.map((n) =>
            n.serviceId === serviceId ? { ...n, status } : n,
          ),
        })),
      setContainerStatus: (serviceId, status: ContainerStatus) =>
        sentinelStore.set((s) => ({
          containers: s.containers.map((c) =>
            c.serviceId === serviceId ? { ...c, status } : c,
          ),
        })),
      setAnomaly: (patch) =>
        sentinelStore.set((s) => ({ anomaly: { ...s.anomaly, ...patch } })),
      setDetector: (kind, patch) => this.setDetector(kind, patch),
      setDiagnosis: (diagnosis) => sentinelStore.set({ diagnosis }),
      openIncident: (input: OpenIncidentInput) => {
        const id = `INC-${this.incidentSeq}`;
        this.incidentSeq += 1;
        const at = this.stepNow();
        const incident: Incident = {
          id,
          title: input.title,
          serviceId: input.serviceId,
          severity: input.severity,
          status: "detected",
          rootCause: input.rootCause,
          action: input.action,
          detectedAt: at,
          stages: pendingStages().map((s) =>
            s.stage === "detected" ? { ...s, status: "complete", at } : s,
          ),
          anomalyScore: input.anomalyScore,
          before: input.before,
          auto: false,
          scenarioId: this.run?.def.id,
        };
        sentinelStore.set((s) => ({ incidents: [...s.incidents, incident] }));
        this.patchRun({ incidentId: id });
        return id;
      },
      updateIncident: (id, patch) =>
        sentinelStore.set((s) => ({
          incidents: s.incidents.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        })),
      startStage: (id, stage, detail) => this.setStage(id, stage, "active", detail),
      completeStage: (id, stage, detail) =>
        this.setStage(id, stage, "complete", detail),
      failStage: (id, stage, detail) => this.setStage(id, stage, "failed", detail),
      pushEvent: (kind, message, opts) => this.pushEvent(kind, message, opts),
      pushTerminal: (text, level) => this.pushTerminal(text, level),
      log: (level, service, message) => this.pushLog(level, service, message),
      notify: (level, title, description) =>
        this.notifier?.(level, title, description),
    };
  }
}

/**
 * Module-level singleton. Importing this module more than once (or mounting the
 * provider twice under StrictMode) reuses the same engine and the same timer.
 */
export const engine = new SimulationEngine();
