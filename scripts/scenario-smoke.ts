/**
 * Scenario smoke test — `npx tsx scripts/scenario-smoke.ts`
 *
 * Drives the real engine (real timers, real store, real scenarios) at a
 * compressed time scale and asserts the invariants the demo depends on:
 *
 *   1. Memory leak five times back to back — every run ends resolved, every
 *      service healthy, the island back to operational.
 *   2. Reset in the middle of remediation — clean healthy state, no incident
 *      stuck mid-stage.
 *   3. Unknown anomaly — ends escalated, and nothing was restarted.
 *   4. No duplicate incident ids, and no timers left running afterwards.
 *
 * The engine advances 1 simulated second per tick regardless of `timeScale`,
 * so the compressed run exercises exactly the same step sequence the browser
 * demo does — only faster.
 */
import { engine } from "../src/lib/simulation/engine";
import { sentinelStore } from "../src/lib/store/sentinel-store";
import type { Incident, ScenarioId } from "../src/lib/types";

/** 4 real ms per simulated second: a ~40 s run finishes in ~160 ms. */
const TICK_MS = 4;
const TIME_SCALE = 250;

let failures = 0;
let checks = 0;

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

async function runToCompletion(id: ScenarioId): Promise<void> {
  engine.runScenario(id);
  await waitFor(`${id} to finish`, () => state().activeScenario === null, 15000);
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

  /* -------- 1. memory leak, five times back to back -------------------- */
  console.log("\n1. Memory leak × 5 back to back");
  const incidentIds: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    await runToCompletion("memory-leak");
    const s = state();
    const run = s.chaosRun;
    check(run?.outcome === "auto_healed", `run ${i} auto-healed`, run?.outcome);
    check(
      s.scenarioPhase === "resolved",
      `run ${i} ended in the resolved phase`,
      s.scenarioPhase,
    );
    check(allHealthy(), `run ${i} left every service healthy`, s.services.map((x) => `${x.id}:${x.status}`));
    check(run?.recoverySec === 18.4, `run ${i} recovered in 18.4s`, run?.recoverySec);
    check(run?.mlDetectedSec === 8.2, `run ${i} detected at +8.2s`, run?.mlDetectedSec);
    check(
      run?.thresholdDetectedSec !== null &&
        (run?.thresholdDetectedSec ?? 0) > (run?.mlDetectedSec ?? 0),
      `run ${i} threshold rule fired after the anomaly detector`,
      run?.thresholdDetectedSec,
    );

    const incident = s.incidents.find((x) => x.id === run?.incidentId);
    check(incident?.status === "resolved", `run ${i} incident resolved`, incident?.status);
    check(incident?.auto === true, `run ${i} incident marked auto-healed`, incident?.auto);
    if (run?.incidentId) incidentIds.push(run.incidentId);

    // The island returns to operational 8 simulated seconds after `recovered`;
    // the scenario tail is longer than that, so it should already be back.
    check(
      s.islandState === "operational",
      `run ${i} island back to operational`,
      s.islandState,
    );
  }
  check(
    new Set(incidentIds).size === incidentIds.length,
    "no duplicate incident ids across runs",
    incidentIds,
  );
  check(
    state().experimentRuns.length === 9,
    "nine experiment runs recorded",
    state().experimentRuns.length,
  );

  /* -------- 2. reset in the middle of remediation ---------------------- */
  console.log("\n2. Reset during remediation");
  engine.runScenario("memory-leak");
  const reached = await waitFor(
    "the remediating phase",
    () => state().scenarioPhase === "remediating",
    15000,
  );
  if (reached) {
    engine.reset();
    await sleep(20);
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
      s.experimentRuns.length === 10 &&
        s.experimentRuns[9].outcome === "cancelled",
      "experiment history kept; the aborted run is marked cancelled",
      s.experimentRuns.map((e) => e.outcome),
    );
    check(
      s.containers.every((c) => c.status === "running"),
      "no container left restarting",
      s.containers.map((c) => `${c.name}:${c.status}`),
    );
  }

  /* -------- 3. unknown anomaly escalates, never restarts --------------- */
  console.log("\n3. Unknown anomaly");
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
    const incident = s.incidents.find((x) => x.id === run?.incidentId);
    check(incident?.status === "escalated", "incident escalated", incident?.status);
    check(incident?.auto === false, "incident not marked auto-healed", incident?.auto);
    check(
      state().services.find((x) => x.id === "orders-service")?.status === "healthy",
      "orders-service drifted back to healthy",
    );
  }

  /* -------- 4. teardown: no leftover timers ---------------------------- */
  console.log("\n4. Teardown");
  engine.reset();
  await sleep(20);
  engine.stop();
  const frozen = JSON.stringify(state().cluster);
  await sleep(60);
  check(
    JSON.stringify(state().cluster) === frozen,
    "no timer keeps writing after stop()",
  );
  check(
    state().experimentRuns.length === 11,
    "experiment history survived every reset",
    state().experimentRuns.length,
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
