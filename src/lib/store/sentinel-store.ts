import { create } from "zustand";
import type {
  Anomaly,
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
  cloneSeedIncidents,
  cloneSeedInfraEdges,
  cloneSeedInfraNodes,
  cloneSeedPolicies,
  cloneSeedServices,
  SEED_NOW,
} from "@/lib/mock-data";
import { aggregateCluster } from "@/lib/simulation/telemetry";

/** Ring-buffer / list caps. */
export const CAPS = {
  events: 200,
  logs: 1000,
  terminal: 200,
} as const;

/** Default healthy detector pair (Isolation Forest + static threshold). */
function initialDetectors(): DetectorResult[] {
  return [
    {
      kind: "threshold",
      label: "Static threshold rule",
      fired: false,
      firedAt: null,
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
  cluster: ClusterMetrics;

  /* Topology (static seeds, but chaos may flip node/container status) */
  containers: Container[];
  infraNodes: InfraNode[];
  infraEdges: InfraEdge[];
  policies: RemediationPolicy[];

  /* Incidents & pipeline */
  incidents: Incident[];
  events: SystemEvent[];
  logs: LogEntry[];
  terminalLines: TerminalLine[];

  /* Detection / diagnosis */
  anomaly: Anomaly;
  diagnosis: Diagnosis | null;
  detectors: DetectorResult[];

  /* Autonomous workflow surface */
  islandState: IslandState;
  scenarioPhase: ScenarioPhase;
  activeScenario: ScenarioId | null;

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
  updateSettings: (patch: Partial<SentinelSettings>) => void;
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
    cluster: aggregateCluster(SEED_NOW, services, 0),

    containers: cloneSeedContainers(),
    infraNodes: cloneSeedInfraNodes(),
    infraEdges: cloneSeedInfraEdges(),
    policies: cloneSeedPolicies(),

    incidents: cloneSeedIncidents(),
    events: [],
    logs: [],
    terminalLines: [],

    anomaly: initialAnomaly(),
    diagnosis: null,
    detectors: initialDetectors(),

    islandState: "operational",
    scenarioPhase: "idle",
    activeScenario: null,

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
      cooldownSec: 1800,
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
  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  reset: () => set(createInitialState()),
}));

/** Non-hook accessors for the engine (module code, outside React). */
export const sentinelStore = {
  get: useSentinelStore.getState,
  set: useSentinelStore.setState,
  subscribe: useSentinelStore.subscribe,
};
