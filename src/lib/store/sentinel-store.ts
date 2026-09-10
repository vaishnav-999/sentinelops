import { create } from "zustand";
import type {
  Anomaly,
  ChaosRunState,
  ClusterMetrics,
  Container,
  ConnectionStatus,
  DetectorResult,
  Diagnosis,
  EnvironmentId,
  ExperimentRun,
  GuardrailState,
  Incident,
  InfraEdge,
  InfraNode,
  IslandState,
  LogEntry,
  MetricSample,
  RemediationExecution,
  RemediationPolicy,
  ScenarioId,
  ScenarioPhase,
  SentinelSettings,
  Service,
  SystemEvent,
  TerminalLine,
  TimeRange,
} from "@/lib/types";
import {
  cloneSeedContainers,
  cloneSeedExecutions,
  cloneSeedIncidents,
  cloneSeedInfraEdges,
  cloneSeedInfraNodes,
  cloneSeedPolicies,
  cloneSeedServices,
  SEED_NOW,
  SEED_SELECTED_EXECUTION_ID,
} from "@/lib/mock-data";
import { aggregateCluster } from "@/lib/simulation/telemetry";

/** Ring-buffer / list caps. */
export const CAPS = {
  events: 200,
  logs: 1000,
  terminal: 200,
  /** Remediation audit trail kept in memory (SPEC §12 "Recent executions"). */
  executions: 50,
  /** Coarse trail: 61 samples × TRAIL_INTERVAL_TICKS = a 5-minute window. */
  trail: 61,
} as const;

/** Default healthy detector pair (Isolation Forest + static threshold). */
function initialDetectors(): DetectorResult[] {
  return [
    {
      kind: "threshold",
      label: "Static threshold rule",
      fired: false,
      firedAt: null,
      value: 90,
      detail: "memory > 90%",
    },
    {
      kind: "ml",
      label: "Isolation Forest",
      fired: false,
      firedAt: null,
      value: 0.08,
    },
  ];
}

function initialAnomaly(): Anomaly {
  return {
    score: 0.08,
    baseline: "normal",
    note: "No abnormal behaviour detected.",
  };
}

export interface SentinelState {
  /* Live telemetry */
  services: Service[];
  histories: Record<string, MetricSample[]>;
  clusterHistory: ClusterMetrics[];
  /**
   * Coarsely sampled cluster history covering ~5 minutes, used for the
   * "delta vs 5 min ago" figures. `clusterHistory` only spans 60 ticks.
   */
  clusterTrail: ClusterMetrics[];
  cluster: ClusterMetrics;

  /* Topology (static seeds, but chaos may flip node/container status) */
  containers: Container[];
  infraNodes: InfraNode[];
  infraEdges: InfraEdge[];
  policies: RemediationPolicy[];

  /* Incidents & pipeline */
  incidents: Incident[];
  /**
   * Audit trail of automated remediation runs, oldest first. Every scenario
   * mints one, whatever it ends in, so a blocked or dry-run attempt is as
   * visible as a successful restart.
   */
  executions: RemediationExecution[];
  /** Which execution the /auto-heal terminal is showing. */
  selectedExecutionId: string | null;
  events: SystemEvent[];
  logs: LogEntry[];
  terminalLines: TerminalLine[];

  /* Detection / diagnosis */
  anomaly: Anomaly;
  diagnosis: Diagnosis | null;
  detectors: DetectorResult[];

  /* Autonomous workflow surface */
  islandState: IslandState;
  /** Engine clock when the island left operational; null while healthy. */
  islandStartedAt: number | null;
  /** Engine clock of the last island state change. */
  islandChangedAt: number;
  scenarioPhase: ScenarioPhase;
  activeScenario: ScenarioId | null;
  /**
   * Live Chaos Lab run console. Set when a run is requested and kept after it
   * finishes, so the result panel survives navigation and only a new run or
   * Reset Demo clears it.
   */
  chaosRun: ChaosRunState | null;

  /* Connection & session */
  live: boolean;
  connection: ConnectionStatus;
  environment: EnvironmentId;
  timeRange: TimeRange;
  reducedMotion: boolean;
  sidebarCollapsed: boolean;

  /* Safety */
  settings: SentinelSettings;
  guardrails: GuardrailState;

  /* Research */
  experimentRuns: ExperimentRun[];
}

export interface SentinelActions {
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setEnvironment: (env: EnvironmentId) => void;
  setTimeRange: (range: TimeRange) => void;
  setReducedMotion: (v: boolean) => void;
  toggleReducedMotion: () => void;
  setLive: (v: boolean) => void;
  /**
   * Flips the simulated telemetry link. While `"lost"` the engine stops
   * writing, so every panel keeps showing its last known values.
   */
  setConnection: (c: ConnectionStatus) => void;
  updateSettings: (patch: Partial<SentinelSettings>) => void;
  /** Open an execution in the /auto-heal terminal. */
  selectExecution: (id: string | null) => void;
  /** Restore the exact seeded healthy state (ids, counters and all). */
  reset: () => void;
}

export type SentinelStore = SentinelState & SentinelActions;

/**
 * Build the seeded healthy state. Fully deterministic (no Date.now / random),
 * so it is safe to evaluate during SSR and reproduces identically after reset.
 */
export function createInitialState(): SentinelState {
  const services = cloneSeedServices();
  const histories: Record<string, MetricSample[]> = {};
  for (const s of services) histories[s.id] = [];

  return {
    services,
    histories,
    clusterHistory: [],
    clusterTrail: [],
    cluster: aggregateCluster(SEED_NOW, services, 0),

    containers: cloneSeedContainers(),
    infraNodes: cloneSeedInfraNodes(),
    infraEdges: cloneSeedInfraEdges(),
    policies: cloneSeedPolicies(),

    incidents: cloneSeedIncidents(),
    executions: cloneSeedExecutions(),
    selectedExecutionId: SEED_SELECTED_EXECUTION_ID,
    events: [],
    logs: [],
    terminalLines: [],

    anomaly: initialAnomaly(),
    diagnosis: null,
    detectors: initialDetectors(),

    islandState: "operational",
    islandStartedAt: null,
    islandChangedAt: SEED_NOW,
    scenarioPhase: "idle",
    activeScenario: null,
    chaosRun: null,

    live: true,
    connection: "ok",
    environment: "production",
    timeRange: "1h",
    reducedMotion: false,
    sidebarCollapsed: false,

    settings: {
      autoRemediation: true,
      dryRun: false,
      restartLimit: 2,
      guardrailWindowSec: 1800,
      cooldownSec: 120,
    },
    guardrails: { actionsByService: {} },

    experimentRuns: [],
  };
}

/**
 * The global store. The simulation engine writes to it via
 * `useSentinelStore.getState()` / `.setState()`; components subscribe read-only
 * through the hook. UI-only concerns (sidebar, env, time range, reduced motion)
 * live here as actions.
 */
export const useSentinelStore = create<SentinelStore>((set) => ({
  ...createInitialState(),

  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setEnvironment: (environment) => set({ environment }),
  setTimeRange: (timeRange) => set({ timeRange }),
  setReducedMotion: (v) => set({ reducedMotion: v }),
  toggleReducedMotion: () =>
    set((s) => ({ reducedMotion: !s.reducedMotion })),
  setLive: (live) => set({ live }),
  setConnection: (connection) => set({ connection }),
  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  selectExecution: (selectedExecutionId) => set({ selectedExecutionId }),
  reset: () => set(createInitialState()),
}));

/** Non-hook accessors for the engine (module code, outside React). */
export const sentinelStore = {
  get: useSentinelStore.getState,
  set: useSentinelStore.setState,
  subscribe: useSentinelStore.subscribe,
};
