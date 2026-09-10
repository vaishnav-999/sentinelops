import type {
  AnomalyPoint,
  ChaosRunState,
  Container,
  ContainerStatus,
  InfraNode,
  DetectorResult,
  EventKind,
  ExperimentRun,
  Incident,
  IncidentStage,
  LogEntry,
  LogLevel,
  RemediationExecution,
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
import {
  NEXT_INCIDENT_SEQ,
  POSTGRES_BASELINE,
  RING_SIZE,
  SEED_NOW,
} from "@/lib/mock-data";
import { ambientLogs } from "./log-stream";
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
  type RemediateInput,
  type RemediationVerdict,
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

/** First execution id the engine mints; the seeded history ends at EXE-2206. */
const NEXT_EXECUTION_SEQ = 2207;

/** Ticks between coarse-trail samples: 5 s × CAPS.trail ≈ a 5-minute window. */
const TRAIL_INTERVAL_TICKS = 5;

/** Idle-event spacing in simulated ms — calm, not one per tick (SPEC §8). */
const CALM_EVENT_MIN_MS = 4000;
const CALM_EVENT_JITTER_MS = 2000;

/** Agent heartbeat cadence, simulated ms. Drives the "3s ago" in the sheet. */
const HEARTBEAT_INTERVAL_MS = 5000;

/** How many replicas back each service, for per-container throughput share. */
const REPLICA_COUNT: Record<string, number> = {
  "api-gateway": 2,
  "orders-service": 2,
};

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
  /** Engine clock the next container/node heartbeat is due. */
  private nextHeartbeatAt = 0;

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
  /** The audit record this run is streaming its terminal transcript into. */
  private executionId: string | null = null;
  /** Monotonic counter behind the EXE-#### ids the engine mints. */
  private executionSeq = NEXT_EXECUTION_SEQ;
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

    // Every run opens an audit record up front, so /auto-heal has something to
    // stream into from the first line — including runs that never act.
    const execution: RemediationExecution = {
      id: `EXE-${this.executionSeq}`,
      incidentId: "",
      policyId: "",
      serviceId: def.target,
      action: "",
      startedAt: this.clock,
      outcome: "in_progress",
      dryRun: sentinelStore.get().settings.dryRun,
      lines: [],
    };
    this.executionSeq += 1;
    this.executionId = execution.id;

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
      executions: cap([...s.executions, execution], CAPS.executions),
      // The newest execution is what the operator wants to watch.
      selectedExecutionId: execution.id,
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

    // Experiment history is research output — it survives a demo reset. So do
    // the operator's own settings: Reset Demo restores the *system* to its
    // seeded healthy state, it does not silently re-enable auto-remediation.
    const { experimentRuns: runs, settings } = sentinelStore.get();

    this.recoveredSince = null;
    this.nextCalmEventAt = 0;
    this.nextHeartbeatAt = 0;
    this.calmIndex = 0;
    this.ticks = 0;
    this.seq = 0;
    this.incidentSeq = NEXT_INCIDENT_SEQ;
    this.stepAtMs = null;
    this.runsSinceReset = 0;
    // Reset Demo clears the guardrail counters with everything else, so the
    // "third action is blocked" story can be replayed from scratch.
    this.executionSeq = NEXT_EXECUTION_SEQ;
    this.executionId = null;
    this.runTiming = nominalTiming();

    sentinelStore.get().reset();
    sentinelStore.set({
      experimentRuns: runs,
      settings,
      live: true,
      connection: "ok",
    });
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
      executions: s.executions.map((exe) => ({
        ...exe,
        startedAt: exe.startedAt + shift,
        completedAt:
          exe.completedAt === undefined ? undefined : exe.completedAt + shift,
        lines: exe.lines.map((l) => ({ ...l, t: l.t + shift })),
      })),
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

    // A cancelled run never reached a verdict, so it leaves no audit record.
    const executionId = this.executionId;
    this.executionId = null;
    if (executionId) {
      sentinelStore.set((s) => ({
        executions: s.executions.filter((e) => e.id !== executionId),
        selectedExecutionId:
          s.selectedExecutionId === executionId
            ? (s.executions.filter((e) => e.id !== executionId).at(-1)?.id ?? null)
            : s.selectedExecutionId,
      }));
    }

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

    // 4a2) Mirror live telemetry onto the containers and topology nodes, so
    //      /infrastructure moves with a chaos run instead of showing seeds.
    this.tickTopology(services);

    // 4a3) Anomaly-score timeline, for the /ml-insights chart.
    const point: AnomalyPoint = { t: this.clock, score: state.anomaly.score };
    sentinelStore.set((s) => ({
      anomalyHistory: pushRing(s.anomalyHistory, point, CAPS.anomalyHistory),
    }));

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

    // 7) Ambient application logs. Unlike the event stream these never go
    //    quiet: a real platform keeps logging, and a chaos run shows up as a
    //    WARN/ERROR burst from the affected service (simulation/log-stream.ts).
    this.pushAmbientLogs(services);
  }

  /**
   * Containers and topology nodes follow their service's live metrics, so a
   * fault is visible on /infrastructure at the same instant it is on /overview.
   * Heartbeats tick on their own slower cadence.
   */
  private tickTopology(services: Service[]): void {
    const byId = new Map(services.map((svc) => [svc.id, svc]));
    const beat = this.clock >= this.nextHeartbeatAt;
    if (beat) this.nextHeartbeatAt = this.clock + HEARTBEAT_INTERVAL_MS;

    sentinelStore.set((state) => {
      const containers: Container[] = state.containers.map((c) => {
        const svc = c.serviceId ? byId.get(c.serviceId) : undefined;
        if (!svc) return c;
        const replicas = REPLICA_COUNT[svc.id] ?? 1;
        // Replicas of one service are never identical; a small stable-ish
        // offset per container keeps the two rows from reading as a copy.
        const skew = 1 + (this.rng() - 0.5) * 0.06;
        return {
          ...c,
          cpu: round(Math.max(0, svc.metrics.cpu * skew), 1),
          memory: round(Math.max(0, svc.metrics.memory * skew), 1),
          requests: Math.round((svc.metrics.throughput / replicas) * skew),
          // A restarting container reports no heartbeat until it is back.
          heartbeatAt:
            c.status === "restarting" || c.status === "stopped"
              ? c.heartbeatAt
              : beat
                ? this.clock
                : c.heartbeatAt,
        };
      });

      const infraNodes: InfraNode[] = state.infraNodes.map((n) => {
        if (n.kind === "internet") return n;
        const svc = n.serviceId ? byId.get(n.serviceId) : undefined;
        if (svc) {
          return {
            ...n,
            status: svc.status,
            metrics: {
              cpu: round(svc.metrics.cpu, 1),
              memory: round(svc.metrics.memory, 1),
              requests: Math.round(svc.metrics.throughput),
            },
            heartbeatAt: beat ? this.clock : n.heartbeatAt,
          };
        }
        // PostgreSQL has no Service record; it walks gently around its own
        // baseline so the node is alive rather than a frozen constant.
        const prev = n.metrics ?? { ...POSTGRES_BASELINE };
        const drift = (base: number, value: number, amp: number) =>
          round(value + (base - value) * 0.2 + (this.rng() - 0.5) * amp, 1);
        return {
          ...n,
          status: "healthy",
          metrics: {
            cpu: drift(POSTGRES_BASELINE.cpu, prev.cpu, 3),
            memory: drift(POSTGRES_BASELINE.memory, prev.memory, 1.6),
            requests: Math.round(drift(POSTGRES_BASELINE.requests, prev.requests, 90)),
          },
          heartbeatAt: beat ? this.clock : n.heartbeatAt,
        };
      });

      return { containers, infraNodes };
    });
  }

  /** Draw and append this tick's ambient log lines in a single store write. */
  private pushAmbientLogs(services: Service[]): void {
    const state = sentinelStore.get();
    const entries = ambientLogs({
      services,
      now: this.clock,
      tickSpanMs: this.tickMs * this.timeScale,
      rng: this.rng,
      anomalyScore: state.anomaly.score,
      remediating:
        state.scenarioPhase === "remediating" || state.scenarioPhase === "verifying",
      nextId: () => this.nextId("log"),
    });
    if (entries.length === 0) return;
    sentinelStore.set((s) => ({ logs: cap([...s.logs, ...entries], CAPS.logs) }));
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

    this.patchExecution({
      outcome: outcome === "escalated" ? "escalated" : "success",
      completedAt: this.clock,
      incidentId: state.chaosRun?.incidentId ?? "",
    });
    this.executionId = null;

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
    const executionId = this.executionId;
    sentinelStore.set((s) => ({
      terminalLines: cap([...s.terminalLines, line], CAPS.terminal),
      executions:
        executionId === null
          ? s.executions
          : s.executions.map((e) =>
              e.id === executionId ? { ...e, lines: [...e.lines, line] } : e,
            ),
    }));
  }

  /** Patch the run's audit record, if one is open. */
  private patchExecution(patch: Partial<RemediationExecution>): void {
    const id = this.executionId;
    if (!id) return;
    sentinelStore.set((s) => ({
      executions: s.executions.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));
  }

  /**
   * The safety layer. Every automatic action passes through here, in this
   * order: guardrail first (a refusal must not be masked by dry-run), then the
   * dry-run switch, then commit.
   *
   * The guardrail counts automatic actions committed against one service inside
   * `guardrailWindowSec` of simulated time. Reaching `restartLimit` means the
   * platform stops trying and hands the incident to an operator — restarting a
   * service a third time is how an autonomous system turns a fault into an
   * outage.
   */
  private remediate(input: RemediateInput): RemediationVerdict {
    const { settings, guardrails } = sentinelStore.get();
    const now = this.stepNow();
    const windowMs = settings.guardrailWindowSec * 1000;
    const recent = (guardrails.actionsByService[input.serviceId] ?? []).filter(
      (t) => now - t < windowMs,
    );

    this.patchExecution({
      policyId: input.policyId,
      action: input.actionKind,
      incidentId: input.incidentId ?? "",
    });

    const commit = (times: number[]) =>
      sentinelStore.set((s) => ({
        guardrails: {
          actionsByService: {
            ...s.guardrails.actionsByService,
            [input.serviceId]: times,
          },
        },
      }));

    // The master switch comes first: with automatic remediation off, nothing
    // may execute regardless of guardrail budget or dry-run — the platform
    // recommends and hands the incident to an operator.
    if (!settings.autoRemediation) {
      this.pushTerminal(
        `automatic remediation disabled — ${input.actionKind} requires operator approval`,
        "error",
      );
      return "not_allowed";
    }

    if (recent.length >= settings.restartLimit) {
      // Prune the expired timestamps while we are here.
      commit(recent);
      const minutes = Math.round(settings.guardrailWindowSec / 60);
      this.pushTerminal(
        `guardrail: restart limit reached (${settings.restartLimit}/${minutes}min) → escalating to operator`,
        "error",
      );
      return "blocked";
    }

    if (settings.dryRun) {
      this.pushTerminal(`DRY RUN: would execute ${input.actionKind}`, "warn");
      return "dry_run";
    }

    commit([...recent, now]);
    return "execute";
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
        const at = this.stepNow();
        sentinelStore.set((s) => {
          if (!s.chaosRun) return { scenarioPhase: STEP_PHASE[id] };
          // A run that expected to auto-heal has no `escalated` node in its
          // stepper. A guardrail refusal or a dry run can still end there, so
          // the node is appended and the steps it never reached are dropped —
          // showing "Remediating · pending" beside "Escalated" would be a lie.
          const known = s.chaosRun.steps.some((x) => x.id === id);
          const steps = known
            ? s.chaosRun.steps.map((x) =>
                x.id === id && x.at === null ? { ...x, at } : x,
              )
            : [
                ...s.chaosRun.steps.filter((x) => x.at !== null),
                { id, at },
              ];
          return {
            scenarioPhase: STEP_PHASE[id],
            chaosRun: { ...s.chaosRun, current: id, steps },
          };
        });
      },
      runConsole: (patch) => this.patchRun(patch),
      remediate: (input) => this.remediate(input),
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
        this.patchExecution({ incidentId: id });
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
