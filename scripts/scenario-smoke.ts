/**
 * Scenario smoke test — `npx tsx scripts/scenario-smoke.ts`
 *
 * Drives the real engine (real timers, real store, real scenarios) at a
 * compressed time scale and asserts the invariants the demo depends on:
 *
 *   1. Memory leak five times, resetting between runs — every run ends
 *      resolved, every service healthy, the island back to operational, and
 *      each one reproduces the slide numbers exactly (a reset restores the
 *      seeded state, so run #1 timing applies every time).
 *   2. Two runs without a reset — the second is drawn, so the numbers vary.
 *   3. Three runs without a reset — the third is refused by the guardrail and
 *      escalates instead of restarting payment-worker a third time.
 *   4. Dry run — recommended, never executed, incident ends escalated.
 *   5. Automatic remediation off — the run stops at the policy check and
 *      escalates as "Awaiting operator approval"; nothing is restarted.
 *   6. Reset in the middle of remediation — clean healthy state, no incident
 *      stuck mid-stage.
 *   7. Unknown anomaly — ends escalated, and nothing was restarted.
 *   8. Route changes during a live run add neither a second engine timer
 *      nor a duplicate toast, and the run still completes.
 *   9. No duplicate incident ids, and no timers left running afterwards.
 *
 * The engine advances 1 simulated second per tick regardless of `timeScale`,
 * so the compressed run exercises exactly the same step sequence the browser
 * demo does — only faster.
 */
import { engine } from "../src/lib/simulation/engine";
import { sentinelStore } from "../src/lib/store/sentinel-store";
import { BASELINE_TIMING, TIMING_RANGE } from "../src/lib/simulation/timing";
import type { Incident, ScenarioId } from "../src/lib/types";

/**
 * The threshold rule is evaluated on the engine tick (1 simulated second), so
 * its hold-down can overshoot by up to one tick. Detection and recovery are
 * choreographed and need no slack.
 */
const TICK_SLACK_SEC = 1.1;

/** 4 real ms per simulated second: a ~40 s run finishes in ~160 ms. */
const TICK_MS = 4;
const TIME_SCALE = 250;

let failures = 0;
let checks = 0;

function inRange(
  value: number | null | undefined,
  [min, max]: readonly [number, number],
  slack = 0,
): boolean {
  return value !== null && value !== undefined && value >= min && value <= max + slack;
}

function check(ok: boolean, label: string, detail?: unknown): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, or fail after `timeoutMs` of real time. */
async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(2);
  }
  check(false, `timed out waiting for ${label}`);
  return false;
}

const state = () => sentinelStore.get();

/** Every scenario the script starts records exactly one experiment row. */
let runsStarted = 0;

async function runToCompletion(id: ScenarioId): Promise<void> {
  runsStarted += 1;
  engine.runScenario(id);
  await waitFor(`${id} to finish`, () => state().activeScenario === null, 15000);
}

/** Reset and let the engine settle, so the next run starts from the seed. */
async function resetDemo(): Promise<void> {
  engine.reset();
  await sleep(20);
}

/** One toast the engine pushed through its notifier sink. */
interface Notification {
  level: string;
  title: string;
  description?: string;
}

const notifications: Notification[] = [];

/**
 * Replays what `SimulationProvider`'s effect does on mount, and its cleanup on
 * unmount. App Router navigation between console routes does not unmount the
 * provider (it lives in the root layout), but StrictMode, HMR and a full
 * remount all run this pair — so the invariant under test is that running it
 * repeatedly mid-run adds neither an engine timer nor a duplicate toast sink.
 */
function mountProvider(): () => void {
  engine.setNotifier((level, title, description) => {
    notifications.push({ level, title, description });
  });
  engine.start();
  return () => engine.setNotifier(null);
}

function terminalHas(fragment: string): boolean {
  return state().terminalLines.some((l) => l.text.includes(fragment));
}

function liveIncident(): Incident | undefined {
  const id = state().chaosRun?.incidentId;
  return state().incidents.find((i) => i.id === id);
}

function allHealthy(): boolean {
  return state().services.every((s) => s.status === "healthy");
}

function stuckIncidents(): Incident[] {
  return state().incidents.filter(
    (i) => i.status !== "resolved" && i.status !== "escalated",
  );
}

async function main(): Promise<void> {
  engine.configure({ tickMs: TICK_MS, timeScale: TIME_SCALE });
  engine.start();
  engine.reset();
  await sleep(20);

  /* -------- 0. every fault card runs end to end ------------------------ */
  console.log("\n0. All four short faults");
  const shortFaults: ScenarioId[] = [
    "cpu-spike",
    "service-crash",
    "latency-injection",
    "cache-saturation",
  ];
  for (const id of shortFaults) {
    await runToCompletion(id);
    const run = state().chaosRun;
    check(run?.outcome === "auto_healed", `${id} auto-healed`, run?.outcome);
    check(
      run?.thresholdDetectedSec !== null,
      `${id} threshold rule fired`,
      run?.thresholdDetectedSec,
    );
    check(allHealthy(), `${id} left every service healthy`);
  }
  engine.reset();
  await sleep(20);

  /* -------- 1. memory leak x5, resetting between runs ------------------ */
  console.log("\n1. Memory leak x5, reset between runs");
  const incidentIds: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    // Resetting between runs clears the guardrail counters, so this section
    // measures the happy path rather than the refusal section 3 is about.
    await resetDemo();
    await runToCompletion("memory-leak");
    const s = state();
    const run = s.chaosRun;
    check(run?.outcome === "auto_healed", `run ${i} auto-healed`, run?.outcome);
    check(
      s.scenarioPhase === "resolved",
      `run ${i} ended in the resolved phase`,
      s.scenarioPhase,
    );
    check(
      allHealthy(),
      `run ${i} left every service healthy`,
      s.services.map((x) => `${x.id}:${x.status}`),
    );
    // A reset restores the seeded state exactly, so every run here is run #1
    // and must reproduce the numbers the slides quote.
    check(
      run?.mlDetectedSec === BASELINE_TIMING.mlDetectSec,
      `run ${i} detected at exactly +${BASELINE_TIMING.mlDetectSec}s`,
      run?.mlDetectedSec,
    );
    check(
      run?.recoverySec === BASELINE_TIMING.recoverySec,
      `run ${i} recovered in exactly ${BASELINE_TIMING.recoverySec}s`,
      run?.recoverySec,
    );
    check(
      inRange(
        run === null || run.thresholdDetectedSec === null || run.mlDetectedSec === null
          ? null
          : Math.round((run.thresholdDetectedSec - run.mlDetectedSec) * 10) / 10,
        TIMING_RANGE.thresholdDelaySec,
        TICK_SLACK_SEC,
      ),
      `run ${i} threshold rule confirmed ${TIMING_RANGE.thresholdDelaySec.join("-")}s after the detector`,
      [run?.mlDetectedSec, run?.thresholdDetectedSec],
    );

    const incident = liveIncident();
    check(incident?.status === "resolved", `run ${i} incident resolved`, incident?.status);
    check(incident?.auto === true, `run ${i} incident marked auto-healed`, incident?.auto);
    if (run?.incidentId) incidentIds.push(run.incidentId);

    const execution = s.executions.at(-1);
    check(
      execution?.outcome === "success",
      `run ${i} execution recorded as success`,
      execution?.outcome,
    );
    check(
      execution?.policyId === "MEM-LEAK-01" && execution.action === "restart_container",
      `run ${i} execution names the policy it ran`,
      [execution?.policyId, execution?.action],
    );

    // The island returns to operational 8 simulated seconds after `recovered`;
    // the scenario tail is longer than that, so it should already be back.
    check(
      s.islandState === "operational",
      `run ${i} island back to operational`,
      s.islandState,
    );
  }
  // Reset restores the id counter too, so a reset run always mints INC-1042 —
  // that reproducibility is the point of resetting between runs.
  check(
    incidentIds.every((id) => id === "INC-1042"),
    "every reset run reproduced the seeded incident id",
    incidentIds,
  );

  /* -------- 2. two runs without a reset: the second is drawn ----------- */
  console.log("\n2. Per-run variation without a reset");
  await resetDemo();
  await runToCompletion("memory-leak");
  const first = state().chaosRun;
  await runToCompletion("memory-leak");
  const second = state().chaosRun;
  check(second?.outcome === "auto_healed", "second run auto-healed", second?.outcome);
  check(
    inRange(second?.mlDetectedSec, TIMING_RANGE.mlDetectSec),
    `second run detected inside ${TIMING_RANGE.mlDetectSec.join("-")}s`,
    second?.mlDetectedSec,
  );
  check(
    inRange(second?.recoverySec, TIMING_RANGE.recoverySec),
    `second run recovered inside ${TIMING_RANGE.recoverySec.join("-")}s`,
    second?.recoverySec,
  );
  // The whole point of the per-run draw: the table must not look hardcoded.
  check(
    second?.mlDetectedSec !== first?.mlDetectedSec ||
      second?.recoverySec !== first?.recoverySec,
    "run 2 timing differs from the baseline run",
    [first?.mlDetectedSec, first?.recoverySec, second?.mlDetectedSec, second?.recoverySec],
  );

  /* -------- 3. guardrail: the third action is refused ------------------ */
  console.log("\n3. Three memory-leak runs without a reset");
  await resetDemo();
  for (let i = 1; i <= 2; i += 1) {
    await runToCompletion("memory-leak");
    check(
      state().chaosRun?.outcome === "auto_healed",
      `guardrail run ${i} still auto-healed`,
      state().chaosRun?.outcome,
    );
  }
  check(
    state().guardrails.actionsByService["payment-worker"]?.length === 2,
    "two automatic actions counted against payment-worker",
    state().guardrails.actionsByService["payment-worker"],
  );

  await runToCompletion("memory-leak");
  {
    const s = state();
    const run = s.chaosRun;
    const minted = s.incidents.filter((i) => i.scenarioId === "memory-leak").map((i) => i.id);
    check(
      new Set(minted).size === minted.length && minted.length === 3,
      "three distinct incident ids across the three runs",
      minted,
    );
    check(run?.outcome === "escalated", "third run escalated", run?.outcome);
    check(run?.action === null, "third run took no action", run?.action);
    check(
      terminalHas("guardrail: restart limit reached (2/30min)"),
      "guardrail line written to the terminal",
      s.terminalLines.slice(-4).map((l) => l.text),
    );
    const incident = liveIncident();
    check(incident?.status === "escalated", "third incident escalated", incident?.status);
    check(
      incident?.outcomeLabel === "Guardrail blocked — escalated to operator",
      "third incident labelled as guardrail-blocked",
      incident?.outcomeLabel,
    );
    check(
      s.executions.at(-1)?.outcome === "escalated",
      "third execution recorded as escalated",
      s.executions.at(-1)?.outcome,
    );
    check(
      s.guardrails.actionsByService["payment-worker"]?.length === 2,
      "the refused action was not counted against the budget",
      s.guardrails.actionsByService["payment-worker"],
    );
    check(allHealthy(), "services drifted back to healthy without an action");
    check(
      s.containers.every((c) => c.status === "running"),
      "no container was restarted a third time",
      s.containers.map((c) => `${c.name}:${c.status}`),
    );
  }
  // Reset Demo must clear the counters, or the guardrail story is one-shot.
  await resetDemo();
  check(
    Object.keys(state().guardrails.actionsByService).length === 0,
    "reset cleared the guardrail counters",
    state().guardrails.actionsByService,
  );

  /* -------- 4. dry run: recommended, never executed -------------------- */
  console.log("\n4. Dry run");
  const containersBeforeDryRun = state().containers.map((c) => `${c.id}:${c.status}`);
  state().updateSettings({ dryRun: true });
  await runToCompletion("memory-leak");
  {
    const s = state();
    const run = s.chaosRun;
    check(run?.outcome === "escalated", "dry run escalated", run?.outcome);
    check(run?.action === null, "dry run executed no action", run?.action);
    check(
      terminalHas("DRY RUN: would execute restart_container"),
      "dry-run line written to the terminal",
      s.terminalLines.slice(-6).map((l) => l.text),
    );
    const incident = liveIncident();
    check(incident?.status === "escalated", "dry-run incident escalated", incident?.status);
    check(
      incident?.outcomeLabel === "Recommended — awaiting approval",
      "dry-run incident labelled as a recommendation",
      incident?.outcomeLabel,
    );
    check(incident?.auto === false, "dry-run incident not marked auto-healed", incident?.auto);
    check(
      s.executions.at(-1)?.dryRun === true,
      "execution flagged as a dry run",
      s.executions.at(-1)?.dryRun,
    );
    check(
      JSON.stringify(s.containers.map((c) => `${c.id}:${c.status}`)) ===
        JSON.stringify(containersBeforeDryRun),
      "nothing was restarted during the dry run",
      s.containers.map((c) => `${c.name}:${c.status}`),
    );
    check(
      Object.values(s.guardrails.actionsByService).every((t) => t.length === 0),
      "a dry run does not consume the guardrail budget",
      s.guardrails.actionsByService,
    );
    check(allHealthy(), "metrics recovered on their own after the dry run");
  }
  state().updateSettings({ dryRun: false });
  await resetDemo();

  /* -------- 5. automatic remediation switched off ---------------------- */
  console.log("\n5. Automatic remediation disabled");
  const containersBeforeManual = state().containers.map((c) => `${c.id}:${c.status}`);
  state().updateSettings({ autoRemediation: false });
  await runToCompletion("memory-leak");
  {
    const s = state();
    const run = s.chaosRun;
    check(run?.outcome === "escalated", "run escalated", run?.outcome);
    check(run?.action === null, "no remediation action was taken", run?.action);
    check(
      run?.steps.every((x) => x.id !== "remediating") ?? false,
      "no remediating step in the stepper",
      run?.steps.map((x) => x.id),
    );
    check(
      terminalHas("automatic remediation disabled"),
      "the refusal was written to the terminal",
      s.terminalLines.slice(-6).map((l) => l.text),
    );
    const incident = liveIncident();
    check(incident?.status === "escalated", "incident escalated", incident?.status);
    check(
      incident?.outcomeLabel === "Awaiting operator approval",
      "incident labelled as awaiting operator approval",
      incident?.outcomeLabel,
    );
    check(incident?.auto === false, "incident not marked auto-healed", incident?.auto);
    check(
      s.executions.at(-1)?.outcome === "escalated",
      "execution recorded as escalated",
      s.executions.at(-1)?.outcome,
    );
    check(
      JSON.stringify(s.containers.map((c) => `${c.id}:${c.status}`)) ===
        JSON.stringify(containersBeforeManual),
      "payment-worker was never restarted",
      s.containers.map((c) => `${c.name}:${c.status}`),
    );
    check(
      Object.values(s.guardrails.actionsByService).every((t) => t.length === 0),
      "a refused action does not consume the guardrail budget",
      s.guardrails.actionsByService,
    );
    check(allHealthy(), "services drifted back to healthy without an action");
  }
  // Operator settings survive Reset Demo, so this has to be undone explicitly.
  await resetDemo();
  check(
    state().settings.autoRemediation === false,
    "Reset Demo keeps the operator's own settings",
    state().settings.autoRemediation,
  );
  state().updateSettings({ autoRemediation: true });
  await resetDemo();

  /* -------- 6. reset in the middle of remediation ---------------------- */
  console.log("\n6. Reset during remediation");
  const runsBeforeAbort = state().experimentRuns.length;
  const executionsBeforeAbort = state().executions.length;
  runsStarted += 1;
  engine.runScenario("memory-leak");
  const reached = await waitFor(
    "the remediating phase",
    () => state().scenarioPhase === "remediating",
    15000,
  );
  if (reached) {
    await resetDemo();
    const s = state();
    check(s.activeScenario === null, "no active scenario after reset", s.activeScenario);
    check(s.scenarioPhase === "idle", "phase back to idle", s.scenarioPhase);
    check(s.chaosRun === null, "run console cleared", s.chaosRun);
    check(allHealthy(), "every service healthy after reset");
    check(s.islandState === "operational", "island operational", s.islandState);
    check(s.incidents.length === 3, "only the three seeded incidents remain", s.incidents.length);
    check(stuckIncidents().length === 0, "no incident stuck mid-stage", stuckIncidents());
    check(s.anomaly.score === 0.08, "anomaly score back to baseline", s.anomaly.score);
    check(
      s.detectors.every((d) => !d.fired),
      "both detectors quiet",
      s.detectors,
    );
    check(
      s.executions.length === executionsBeforeAbort,
      "the aborted run left no execution record",
      s.executions.length,
    );
    check(
      s.experimentRuns.length === runsBeforeAbort + 1 &&
        s.experimentRuns[s.experimentRuns.length - 1].outcome === "cancelled",
      "experiment history kept; the aborted run is marked cancelled",
      s.experimentRuns.map((e) => e.outcome),
    );
    check(
      s.containers.every((c) => c.status === "running"),
      "no container left restarting",
      s.containers.map((c) => `${c.name}:${c.status}`),
    );
  }

  /* -------- 7. unknown anomaly escalates, never restarts --------------- */
  console.log("\n7. Unknown anomaly");
  const containersBefore = state().containers.map((c) => `${c.id}:${c.status}`);
  await runToCompletion("unknown-anomaly");
  {
    const s = state();
    const run = s.chaosRun;
    check(run?.outcome === "escalated", "run escalated", run?.outcome);
    check(s.scenarioPhase === "escalated", "phase is escalated", s.scenarioPhase);
    check(s.islandState === "escalated", "island escalated", s.islandState);
    check(run?.action === null, "no remediation action was taken", run?.action);
    check(
      run?.steps.every((x) => x.id !== "remediating") ?? false,
      "no remediating step in the stepper",
    );
    check(
      JSON.stringify(s.containers.map((c) => `${c.id}:${c.status}`)) ===
        JSON.stringify(containersBefore),
      "no container was restarted",
    );
    const incident = liveIncident();
    check(incident?.status === "escalated", "incident escalated", incident?.status);
    check(incident?.auto === false, "incident not marked auto-healed", incident?.auto);
    check(
      state().services.find((x) => x.id === "orders-service")?.status === "healthy",
      "orders-service drifted back to healthy",
    );
  }

  /* -------- 8. route changes during a live run ------------------------- */
  console.log("\n8. Navigating between routes during a run");
  await resetDemo();
  {
    // Baseline tick rate with a single provider mounted: the engine advances
    // the simulated clock one second per tick, so the clock delta over a fixed
    // window is a direct count of the timers running.
    let unmount = mountProvider();
    const beforeClock = state().cluster.t;
    await sleep(120);
    const baselineTicks = (state().cluster.t - beforeClock) / 1000;

    notifications.length = 0;
    runsStarted += 1;
    engine.runScenario("memory-leak");

    // Six route changes while the scenario plays, each unmounting and
    // remounting the provider the way a full remount would.
    for (let i = 0; i < 6; i += 1) {
      await sleep(25);
      unmount();
      unmount = mountProvider();
    }

    const midClock = state().cluster.t;
    await sleep(120);
    const afterTicks = (state().cluster.t - midClock) / 1000;
    check(
      afterTicks <= baselineTicks * 1.5,
      "route changes did not add a second engine timer",
      [baselineTicks, afterTicks],
    );

    await waitFor(
      "memory-leak to finish across the navigations",
      () => state().activeScenario === null,
      15000,
    );

    check(
      state().chaosRun?.outcome === "auto_healed",
      "the run still auto-healed across the navigations",
      state().chaosRun?.outcome,
    );

    const keys = notifications.map(
      (n) => `${n.level}|${n.title}|${n.description ?? ""}`,
    );
    const duplicated = keys.filter((k, i) => keys.indexOf(k) !== i);
    check(duplicated.length === 0, "no toast was delivered twice", duplicated.slice(0, 3));
    check(
      notifications.length > 0,
      "toasts were still delivered after remounting",
      notifications.length,
    );
    check(
      stuckIncidents().length === 0,
      "no incident left mid-stage by the navigations",
      stuckIncidents().map((x) => x.id),
    );

    unmount();
  }

  /* -------- 9. teardown: no leftover timers ---------------------------- */
  console.log("\n9. Teardown");
  await resetDemo();
  check(
    state().executions.length === 6,
    "reset restored the six seeded executions",
    state().executions.length,
  );
  check(
    state().policies.length === 7,
    "seven remediation policies are seeded",
    state().policies.length,
  );
  engine.stop();
  const frozen = JSON.stringify(state().cluster);
  await sleep(60);
  check(
    JSON.stringify(state().cluster) === frozen,
    "no timer keeps writing after stop()",
  );
  check(
    state().experimentRuns.length === runsStarted,
    "experiment history survived every reset",
    [state().experimentRuns.length, runsStarted],
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
