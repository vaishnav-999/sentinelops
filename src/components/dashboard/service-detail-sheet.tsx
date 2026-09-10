"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/charts/sparkline";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { METRIC_META, formatMetricValue, formatUptimeSince } from "@/lib/metrics";
import { breachingServices, type MetricKey } from "@/lib/simulation/thresholds";
import {
  SERVICE_STATUS_LABEL,
  SERVICE_STATUS_TONE,
  TONE_BADGE,
  TONE_TEXT,
} from "@/lib/tone";
import type { MetricSample } from "@/lib/types";

const DETAIL_METRICS: MetricKey[] = [
  "cpu",
  "memory",
  "latencyP95",
  "errorRate",
  "throughput",
];

/**
 * Service detail drawer (SPEC §8: "a detail drawer or service page"). Reads the
 * service straight out of the store by id, so it keeps updating live while open.
 */
export function ServiceDetailSheet({
  serviceId,
  onClose,
}: {
  serviceId: string | null;
  onClose: () => void;
}) {
  const service = useSentinelStore((s) =>
    serviceId ? s.services.find((x) => x.id === serviceId) : undefined,
  );
  const history = useSentinelStore((s) =>
    serviceId ? s.histories[serviceId] : undefined,
  );
  const now = useSentinelStore((s) => s.cluster.t);
  const services = useSentinelStore((s) => s.services);

  const tone = service ? SERVICE_STATUS_TONE[service.status] : "muted";
  const samples: MetricSample[] = history ?? [];

  return (
    <Sheet
      open={serviceId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        {service ? (
          <>
            <SheetHeader className="border-b border-border pr-12">
              <div className="flex items-center gap-2">
                <SheetTitle>{service.name}</SheetTitle>
                <Badge variant={TONE_BADGE[tone]}>
                  {SERVICE_STATUS_LABEL[service.status]}
                </Badge>
              </div>
              <SheetDescription className={numeric}>
                {service.id} · :{service.port}
              </SheetDescription>
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4">
              <Field label="Image" value={service.image} mono />
              <Field label="Container" value={service.containerId} mono />
              <Field
                label="Uptime"
                value={`${service.uptimePct.toFixed(3)}%`}
                mono
              />
              <Field
                label="Running for"
                value={formatUptimeSince(service.startedAt, now)}
                mono
              />
            </dl>

            <div className="flex flex-col gap-3 overflow-y-auto border-t border-border px-4 py-4">
              <span className="label">Live metrics</span>
              {DETAIL_METRICS.map((key) => {
                const breaching = breachingServices(services, key).includes(
                  service.id,
                );
                const values = samples.map((s) => s[key]);
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 truncate text-xs text-text-2">
                      {key === "throughput" && service.throughputUnit === "jobs/min"
                        ? "Jobs/min"
                        : METRIC_META[key].label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Sparkline
                        values={values}
                        tone={breaching ? "crit" : "brand"}
                        height={24}
                      />
                    </div>
                    <span
                      className={cn(
                        "w-16 shrink-0 text-right text-sm",
                        numeric,
                        breaching ? TONE_TEXT.crit : "text-text",
                      )}
                    >
                      {formatMetricValue(service.metrics[key], key)}
                    </span>
                  </div>
                );
              })}
              {service.metrics.hitRate !== undefined ? (
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-xs text-text-2">Cache hit rate</span>
                  <span className={cn("text-sm text-text", numeric)}>
                    {service.metrics.hitRate.toFixed(1)}%
                  </span>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-sm text-text", mono && numeric)}>
        {value}
      </dd>
    </div>
  );
}
