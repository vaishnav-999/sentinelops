import type {
  Anomaly,
  ChaosRunState,
  ContainerStatus,
  DetectorResult,
  Diagnosis,
  EventKind,
  Incident,
  IncidentSeverity,
  IncidentStage,
  IslandState,
  LogLevel,
  RunStepId,
  ScenarioId,
  ScenarioPhase,
  Severity,
  ServiceMetrics,
  ServiceStatus,
  TerminalLevel,
} from "@/lib/types";

/**
 * A scenario is a declarative timeline of steps. Each step fires once, when the
 * scenario's *scaled* elapsed time first passes its `atMs` offset. Steps never
 * own timers themselves — the engine's single interval drives them — which is
 * what makes runs cancellable and re-runnable with zero leaked callbacks.
 */

export interface ScenarioStep {
  /** Offset from scenario start, in scaled ms. */
  atMs: number;
  /** Optional label for debugging / future timeline UI. */
  label?: string;
  run: (ctx: ScenarioContext) => void;
}

/** Metric a run console charts (a subset of ServiceMetrics keys). */
export type ScenarioMetric = ChaosRunState["metric"];

export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  /** Fault signature this scenario simulates (for the diagnoser). */
  faultType: string;
  /** Target service id. */
  target: string;
  /** Metric the run console charts, with a threshold line. */
  metric: ScenarioMetric;
  /** Static rule the engine evaluates live against the target service. */
  threshold: number;
  /** Direct label for the threshold rule, e.g. "memory > 90%". */
  thresholdLabel: string;
  /** What the run is expected to end in — drives the final stepper node. */
  expected: "auto_heal" | "escalate";
  steps: ScenarioStep[];
}

/** Everything needed to mint the incident a run opens. */
export interface OpenIncidentInput {
  title: string;
  serviceId: string;
  severity: IncidentSeverity;
  rootCause: string;
  /** Remediation action taken or recommended, e.g. "Restart container". */
  action: string;
  anomalyScore?: number;
  before?: Partial<ServiceMetrics>;
}

export type NotifyLevel = "info" | "success" | "warning" | "error";

/**
 * The controlled surface a scenario step may touch. The engine binds these to
 * itself + the store, so scenarios stay declarative and testable.
 */
export interface ScenarioContext {
  /**
   * Simulated wall-clock, epoch ms. While a step is executing this returns the
   * step's *scheduled* time, not the tick time, so choreographed durations
   * (detection at +8.2 s, recovery in 18.4 s) come out exact regardless of how
   * coarsely the engine happens to be ticking.
   */
  now(): number;
  setPhase(phase: ScenarioPhase): void;
  setIsland(state: IslandState): void;
  /** Advance the run-console stepper (also mirrors into `scenarioPhase`). */
  step(id: RunStepId): void;
  /** Patch the run-console state (notes, action, health checks, result). */
  runConsole(patch: Partial<ChaosRunState>): void;
  /** Record a passed post-remediation health check in the run console. */
  healthCheck(text: string): void;
  /** Shift the mean the noise walk reverts toward for a service. */
  setServiceTarget(serviceId: string, patch: Partial<ServiceMetrics>): void;
  /**
   * Set a service's live metrics *and* its walk target in one move.
   *
   * The mean-reverting walk lags a moving target by roughly `slope / reversion`,
   * so a ramp expressed only as targets never actually reaches the values the
   * demo quotes — and a threshold rule sitting near the top of the ramp then
   * fires only sometimes. Ramp stages therefore state the value the operator
   * should see; the noise still wobbles around it between stages.
   */
  setServiceMetrics(serviceId: string, patch: Partial<ServiceMetrics>): void;
  /** Reset a service's walk target back to its healthy baseline. */
  resetServiceTarget(serviceId: string): void;
  setServiceStatus(serviceId: string, status: ServiceStatus): void;
  setContainerStatus(serviceId: string, status: ContainerStatus): void;
  setAnomaly(patch: Partial<Anomaly>): void;
  setDetector(kind: DetectorResult["kind"], patch: Partial<DetectorResult>): void;
  setDiagnosis(diagnosis: Diagnosis | null): void;
  /** Open the run's incident; returns the minted id (INC-1042, …). */
  openIncident(input: OpenIncidentInput): string;
  updateIncident(id: string, patch: Partial<Incident>): void;
  /** Mark an incident stage active, then complete, with an optional detail. */
  startStage(id: string, stage: IncidentStage, detail?: string): void;
  completeStage(id: string, stage: IncidentStage, detail?: string): void;
  failStage(id: string, stage: IncidentStage, detail?: string): void;
  pushEvent(
    kind: EventKind,
    message: string,
    opts?: { severity?: Severity; serviceId?: string },
  ): void;
  pushTerminal(text: string, level?: TerminalLevel): void;
  log(level: LogLevel, service: string, message: string): void;
  /** Toast. Used sparingly — never during normal operation (SPEC §17). */
  notify(level: NotifyLevel, title: string, description?: string): void;
  /**
   * Engine-internal: tells the context which step is executing so `now()` can
   * return the scheduled time. Scenarios never call this.
   */
  mark(atMs: number | null): void;
}

/**
 * A live run of a scenario definition. `advance(elapsed)` fires any steps whose
 * time has come; `done` flips true once the last step has fired (or after
 * cancellation).
 */
export class ScenarioRun {
  readonly def: ScenarioDefinition;
  private readonly ctx: ScenarioContext;
  private index = 0;
  private cancelled = false;

  constructor(def: ScenarioDefinition, ctx: ScenarioContext) {
    // Steps must be in ascending time order; sort defensively.
    this.def = { ...def, steps: [...def.steps].sort((a, b) => a.atMs - b.atMs) };
    this.ctx = ctx;
  }

  get id(): ScenarioId {
    return this.def.id;
  }

  get done(): boolean {
    return this.cancelled || this.index >= this.def.steps.length;
  }

  /** Fire every step whose `atMs` has been reached. Returns true when complete. */
  advance(elapsedMs: number): boolean {
    if (this.cancelled) return true;
    while (
      this.index < this.def.steps.length &&
      this.def.steps[this.index].atMs <= elapsedMs
    ) {
      const step = this.def.steps[this.index];
      this.index += 1;
      // Pin `now()` to the step's scheduled time for the duration of the step.
      this.ctx.mark(step.atMs);
      try {
        step.run(this.ctx);
      } finally {
        this.ctx.mark(null);
      }
    }
    return this.done;
  }

  cancel(): void {
    this.cancelled = true;
  }
}
