import type { Metadata } from "next";
import { OverviewHeader } from "@/components/dashboard/overview-header";
import { HealthNucleus } from "@/components/dashboard/health-nucleus";
import { MetricsStrip } from "@/components/dashboard/metrics-strip";
import { TelemetryChart } from "@/components/charts/telemetry-chart";
import { AnomalyPanel } from "@/components/dashboard/anomaly-panel";
import { ServiceHealth } from "@/components/dashboard/service-health";
import { EventStream } from "@/components/dashboard/event-stream";

export const metadata: Metadata = {
  title: "Overview — SentinelOps",
};

/**
 * A 12-column dense grid at desktop width: health nucleus beside the six
 * headline metrics, then telemetry beside anomaly intelligence, then service
 * health beside the live activity stream. Panels are siblings — never nested —
 * and sit on the locked 12px gutter.
 */
export default function OverviewPage() {
  return (
    <>
      <OverviewHeader />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="lg:col-span-4 xl:col-span-3">
          <HealthNucleus />
        </div>
        <div className="lg:col-span-8 xl:col-span-9">
          <MetricsStrip />
        </div>

        <div className="lg:col-span-8">
          <TelemetryChart />
        </div>
        <div className="lg:col-span-4">
          <AnomalyPanel />
        </div>

        <div className="lg:col-span-8">
          <ServiceHealth />
        </div>
        <div className="flex max-h-[420px] flex-col lg:col-span-4">
          <EventStream />
        </div>
      </div>
    </>
  );
}
