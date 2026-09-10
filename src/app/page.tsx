"use client";

/**
 * TEMPORARY engine-verification page.
 *
 * Not the real Overview — this exists only to prove the simulation engine +
 * store + api wiring work end to end. It reads live values from the store and
 * drives the engine through the api / engine singleton. The real console shell
 * and Overview replace this in the next phase.
 */

import { api } from "@/lib/api";
import { engine } from "@/lib/simulation/engine";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { ServiceStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { numeric } from "@/lib/utils";

const STATUS_STYLES: Record<ServiceStatus, string> = {
  healthy: "text-ok",
  degraded: "text-warn",
  critical: "text-crit",
  recovering: "text-brand",
};

function Stat({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClassName?: string;
}) {
  return (
    <div className="border-border bg-card rounded-lg border p-5">
      <div className="text-muted text-xs font-medium tracking-wide uppercase">
        {label}
      </div>
      <div className={`${numeric} mt-2 text-3xl ${valueClassName ?? "text-text"}`}>
        {value}
      </div>
      {hint ? <div className="text-text-2 mt-1 text-sm">{hint}</div> : null}
    </div>
  );
}

export default function Home() {
  const cluster = useSentinelStore((s) => s.cluster);
  const anomaly = useSentinelStore((s) => s.anomaly);
  const live = useSentinelStore((s) => s.live);
  const phase = useSentinelStore((s) => s.scenarioPhase);
  const island = useSentinelStore((s) => s.islandState);
  const payment = useSentinelStore((s) =>
    s.services.find((svc) => svc.id === "payment-worker"),
  );

  return (
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-text text-2xl font-semibold tracking-tight">
            SentinelOps
          </h1>
          <span className="border-border text-text-2 rounded-full border px-2 py-0.5 text-xs">
            Demo · Simulated data
          </span>
        </div>
        <p className="text-text-2 text-sm">
          Engine verification harness — foundation phase. The real Overview
          console arrives next.
        </p>
        <div className="text-muted flex items-center gap-4 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block size-2 rounded-full ${
                live ? "bg-ok" : "bg-muted"
              }`}
            />
            {live ? "LIVE" : "PAUSED"}
          </span>
          <span>
            phase: <span className={numeric}>{phase}</span>
          </span>
          <span>
            island: <span className={numeric}>{island}</span>
          </span>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="Cluster Memory"
          value={`${cluster.memory.toFixed(1)}%`}
          hint={`Health ${cluster.healthScore.toFixed(1)} · CPU ${cluster.cpu.toFixed(1)}%`}
          valueClassName="text-brand"
        />
        <Stat
          label="payment-worker"
          value={payment ? payment.status : "—"}
          hint={
            payment
              ? `mem ${payment.metrics.memory.toFixed(1)}% · err ${payment.metrics.errorRate.toFixed(2)}%`
              : undefined
          }
          valueClassName={payment ? STATUS_STYLES[payment.status] : undefined}
        />
        <Stat
          label="Anomaly Score"
          value={anomaly.score.toFixed(2)}
          hint={`baseline: ${anomaly.baseline}`}
          valueClassName={anomaly.score >= 0.5 ? "text-ai" : "text-text"}
        />
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            void api.injectChaos({ scenario: "memory-leak" });
          }}
        >
          Run Memory Leak
        </Button>
        <Button variant="outline" onClick={() => engine.reset()}>
          Reset
        </Button>
        <Button
          variant="ghost"
          onClick={() => (live ? engine.pause() : engine.resume())}
        >
          {live ? "Pause" : "Resume"}
        </Button>
        <span className="text-muted text-xs">
          Watch memory climb, payment-worker go critical, the anomaly score spike
          toward 0.94, then auto-heal back to healthy.
        </span>
      </section>
    </main>
  );
}
