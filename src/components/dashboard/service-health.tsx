"use client";

import { useState } from "react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ServiceDetailSheet } from "@/components/dashboard/service-detail-sheet";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { formatCompactNumber, formatUptimeSince } from "@/lib/metrics";
import { breachingServices, type MetricKey } from "@/lib/simulation/thresholds";
import {
  SERVICE_STATUS_LABEL,
  SERVICE_STATUS_TONE,
  TONE_DOT,
  TONE_TEXT,
  isUnsettled,
} from "@/lib/tone";

/** Metric columns that can show a breach, so one hot service stands out. */
const BREACHABLE: MetricKey[] = ["cpu", "memory", "latencyP95", "errorRate"];

/**
 * Service health (SPEC §8). A table rather than cards: eight fields across six
 * rows is a scanning job, and rows keep the numeric columns aligned.
 */
export function ServiceHealth() {
  const services = useSentinelStore((s) => s.services);
  const now = useSentinelStore((s) => s.cluster.t);
  const reduced = useReducedMotion();
  const [selected, setSelected] = useState<string | null>(null);

  const breaches = new Map<MetricKey, Set<string>>(
    BREACHABLE.map((key) => [key, new Set(breachingServices(services, key))]),
  );
  const degraded = services.filter((s) => s.status !== "healthy").length;

  return (
    <>
      <Panel>
        <PanelHeader
          title="Service health"
          actions={
            <span className="label">
              {degraded === 0
                ? `${services.length} services healthy`
                : `${degraded} of ${services.length} need attention`}
            </span>
          }
        />

        <Table className="text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4 text-xs font-medium text-muted">
                Service
              </TableHead>
              <TableHead className="text-xs font-medium text-muted">
                Status
              </TableHead>
              <Num>CPU</Num>
              <Num>Memory</Num>
              <Num>P95</Num>
              <Num>Requests</Num>
              <TableHead className="text-xs font-medium text-muted">
                Container
              </TableHead>
              <Num className="pr-4">Uptime</Num>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((service) => {
              const tone = SERVICE_STATUS_TONE[service.status];
              const hot = (key: MetricKey) =>
                breaches.get(key)?.has(service.id) ?? false;

              return (
                <TableRow
                  key={service.id}
                  onClick={() => setSelected(service.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="px-4">
                    <span className="font-medium text-text">{service.name}</span>
                    <span className={cn("ml-2 text-xs text-muted", numeric)}>
                      :{service.port}
                    </span>
                  </TableCell>

                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          TONE_DOT[tone],
                          isUnsettled(service.status) &&
                            !reduced &&
                            "animate-pulse",
                        )}
                      />
                      <span className={cn("text-xs font-medium", TONE_TEXT[tone])}>
                        {SERVICE_STATUS_LABEL[service.status]}
                      </span>
                    </span>
                  </TableCell>

                  <Value hot={hot("cpu")}>{service.metrics.cpu.toFixed(1)}%</Value>
                  <Value hot={hot("memory")}>
                    {service.metrics.memory.toFixed(1)}%
                  </Value>
                  <Value hot={hot("latencyP95")}>
                    {Math.round(service.metrics.latencyP95)} ms
                  </Value>
                  {/* Throughput has no per-service threshold (see thresholds.ts). */}
                  <Value hot={false}>
                    {formatCompactNumber(service.metrics.throughput)}
                    <span className="text-muted">
                      {service.throughputUnit === "rpm" ? " rpm" : " jobs"}
                    </span>
                  </Value>

                  <TableCell className={cn("text-xs text-text-2", numeric)}>
                    {service.containerId.slice(0, 12)}
                  </TableCell>

                  <TableCell className={cn("pr-4 text-right text-text-2", numeric)}>
                    {formatUptimeSince(service.startedAt, now)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Panel>

      <ServiceDetailSheet
        serviceId={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

function Num({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TableHead className={cn("text-right text-xs font-medium text-muted", className)}>
      {children}
    </TableHead>
  );
}

function Value({
  hot,
  children,
}: {
  hot: boolean;
  children: React.ReactNode;
}) {
  return (
    <TableCell
      className={cn("text-right", numeric, hot ? TONE_TEXT.crit : "text-text")}
    >
      {children}
    </TableCell>
  );
}
