/** Simulation layer barrel. */
export * from "./noise";
export * from "./health";
export * from "./telemetry";
export * from "./scenario-runner";
export { SimulationEngine, engine, getScenario, COUNTDOWN_MS } from "./engine";
export type { EngineOptions, EngineNotifier } from "./engine";
export { memoryLeakScenario } from "./scenarios/memory-leak";
export { unknownAnomalyScenario } from "./scenarios/unknown-anomaly";
export {
  buildStandardScenario,
  cpuSpikeScenario,
  serviceCrashScenario,
  latencyInjectionScenario,
  cacheSaturationScenario,
} from "./scenarios/standard";
