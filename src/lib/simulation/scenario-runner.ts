import type {
  Anomaly,
  DetectorResult,
  Diagnosis,
  EventKind,
  IslandState,
  LogLevel,
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

export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  /** Fault signature this scenario simulates (for the diagnoser). */
  faultType: string;
  /** Target service id. */
  target: string;
  steps: ScenarioStep[];
}

/**
 * The controlled surface a scenario step may touch. The engine binds these to
 * itself + the store, so scenarios stay declarative and testable.
 */
export interface ScenarioContext {
  /** Simulated wall-clock (advances with time-scale), epoch ms. */
  now(): number;
  setPhase(phase: ScenarioPhase): void;
  setIsland(state: IslandState): void;
  /** Shift the mean the noise walk reverts toward for a service. */
  setServiceTarget(serviceId: string, patch: Partial<ServiceMetrics>): void;
  /** Reset a service's walk target back to its healthy baseline. */
  resetServiceTarget(serviceId: string): void;
  setServiceStatus(serviceId: string, status: ServiceStatus): void;
  setAnomaly(patch: Partial<Anomaly>): void;
  setDetector(kind: DetectorResult["kind"], patch: Partial<DetectorResult>): void;
  setDiagnosis(diagnosis: Diagnosis | null): void;
  pushEvent(
    kind: EventKind,
    message: string,
    opts?: { severity?: Severity; serviceId?: string },
  ): void;
  pushTerminal(text: string, level?: TerminalLevel): void;
  log(level: LogLevel, service: string, message: string): void;
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
      step.run(this.ctx);
    }
    return this.done;
  }

  cancel(): void {
    this.cancelled = true;
  }
}
