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
import { formatCompactNumber } from "@/lib/metrics";
import { SERVICE_STATUS_LABEL, SERVICE_STATUS_TONE, TONE_BADGE } from "@/lib/tone";

/**
 * Node detail drawer for /infrastructure. Everything is read from the store by
 * id, so the panel keeps updating while it is open — including during a chaos
 * run on the very node you are looking at.
 */

/** "just now" / "3s ago" / "2m ago" — second-accurate, unlike formatAgo. */
function heartbeatAgo(at: number | undefined, now: number): string {
  if (at === undefined) return "no heartbeat";
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec <= 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
}

export function NodeDetailSheet({
  nodeId,
  onClose,
}: {
  nodeId: string | null;
  onClose: () => void;
}) {
  const node = useSentinelStore((s) =>
    nodeId ? s.infraNodes.find((n) => n.id === nodeId) : undefined,
  );
  const container = useSentinelStore((s) =>
    node?.meta?.containerId
      ? s.containers.find((c) => c.id === node.meta?.containerId)
      : undefined,
  );
  const history = useSentinelStore((s) =>
    node?.serviceId ? s.histories[node.serviceId] : undefined,
  );
  const service = useSentinelStore((s) =>
    node?.serviceId ? s.services.find((x) => x.id === node.serviceId) : undefined,
  );
  const now = useSentinelStore((s) => s.cluster.t);

  const tone = node?.status ? SERVICE_STATUS_TONE[node.status] : "muted";
  const samples = history ?? [];
  const unit = service?.throughputUnit === "jobs/min" ? "jobs/min" : "req/min";

  return (
    <Sheet
      open={nodeId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        {node ? (
          <>
            <SheetHeader className="border-b border-border pr-12">
              <div className="flex items-center gap-2">
                <SheetTitle>{node.label}</SheetTitle>
                <Badge variant={TONE_BADGE[tone]}>
                  {node.status ? SERVICE_STATUS_LABEL[node.status] : "Healthy"}
                </Badge>
              </div>
              <SheetDescription className={numeric}>
                {node.id} · {node.kind}
              </SheetDescription>
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4">
              <Field
                label="Container id"
                value={node.meta?.containerId ?? "—"}
                mono
              />
              <Field label="Port" value={node.meta?.port?.toString() ?? "—"} mono />
              <Field label="Image" value={node.meta?.image ?? "—"} mono />
              <Field
                label="Container status"
                value={container?.status ?? "running"}
                mono
              />
            </dl>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border px-4 py-4">
              <Stat
                label="CPU"
                value={`${(node.metrics?.cpu ?? 0).toFixed(1)}%`}
              />
              <Stat
                label="Memory"
                value={`${(node.metrics?.memory ?? 0).toFixed(1)}%`}
              />
              <Stat
                label={node.id === "postgres" ? "Queries/min" : unit}
                value={formatCompactNumber(node.metrics?.requests ?? 0)}
              />
              <Stat
                label="Last heartbeat"
                value={heartbeatAgo(node.heartbeatAt, now)}
              />
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto border-t border-border px-4 py-4">
              {samples.length >= 2 ? (
                <>
                  <MiniChart
                    label="CPU"
                    values={samples.map((s) => s.cpu)}
                    current={`${(node.metrics?.cpu ?? 0).toFixed(1)}%`}
                    tone={node.status === "critical" ? "crit" : "brand"}
                  />
                  <MiniChart
                    label="Memory"
                    values={samples.map((s) => s.memory)}
                    current={`${(node.metrics?.memory ?? 0).toFixed(1)}%`}
                    tone={node.status === "critical" ? "crit" : "brand"}
                  />
                </>
              ) : (
                <p className="text-sm text-muted">
                  {node.id === "postgres"
                    ? "PostgreSQL is monitored at the node level only — no per-service time series in this demo."
                    : "Collecting telemetry…"}
                </p>
              )}
              <p className="text-xs text-muted">
                Demo · simulated telemetry
              </p>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function MiniChart({
  label,
  values,
  current,
  tone,
}: {
  label: string;
  values: number[];
  current: string;
  tone: "brand" | "crit";
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className={cn("text-sm text-text", numeric)}>{current}</span>
      </div>
      <div className="mt-1">
        <Sparkline values={values} tone={tone} height={56} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={cn("mt-0.5 truncate text-sm text-text", numeric)}>{value}</div>
    </div>
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
