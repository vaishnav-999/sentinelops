/** Simulation layer barrel. */
export * from "./noise";
export * from "./health";
export * from "./telemetry";
export * from "./scenario-runner";
export { SimulationEngine, engine } from "./engine";
export type { EngineOptions } from "./engine";
export { memoryLeakScenario } from "./scenarios/memory-leak";
export { unknownAnomalyScenario } from "./scenarios/unknown-anomaly";
