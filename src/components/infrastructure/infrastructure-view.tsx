"use client";

import { useState } from "react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { COUNTS } from "@/lib/mock-data";
import { formatCompactNumber } from "@/lib/metrics";
import {
  SERVICE_STATUS_LABEL,
  SERVICE_STATUS_TONE,
  TONE_BADGE,
  TONE_DOT,
} from "@/lib/tone";
import { TopologyMap } from "./topology-map";
import { NodeDetailSheet } from "./node-detail-sheet";

/**
 * /infrastructure — counts, the live system map and a node drawer.
 *
 * Below 768px the diagram is replaced by a plain vertical list of the same
 * nodes: a topology drawn for 900px does not survive a phone, and a list of
 * nodes with their status and load is the honest small-screen equivalent.
 */
export function InfrastructureView() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <div className="flex flex-col gap-3">
        <CountsRow />

        <Panel>
          <PanelHeader
            title="System topology"
            actions={
              <span className="text-xs text-muted">Demo · simulated</span>
            }
          />
          <div className="hidden p-4 md:block">
            <TopologyMap onSelect={setSelected} />
          </div>
          <div className="md:hidden">
            <NodeList onSelect={setSelected} />
          </div>
        </Panel>
      </div>

      <NodeDetailSheet nodeId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function CountsRow() {
  const containers = useSentinelStore((s) => s.containers);
  const services = useSentinelStore((s) => s.services);

  const running = containers.filter((c) => c.status === "running").length;
  const unhealthy = services.filter((s) => s.status !== "healthy").length;

  return (
    <Panel>
      <div className="grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x">
        <Count label="Services" value={COUNTS.services} note={`${services.length - unhealthy} healthy`} />
        <Count
          label="Containers"
          value={COUNTS.containers}
          note={`${running} running`}
        />
        <Count label="Databases" value={COUNTS.databases} note="PostgreSQL 16.2" />
        <Count label="Caches" value={COUNTS.caches} note="Redis 7.2" />
      </div>
    </Panel>
  );
}

function Count({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note: string;
}) {
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0 sm:border-b-0">
      <div className="label">{label}</div>
      <div className={cn("mt-1 text-xl text-text", numeric)}>{value}</div>
      <div className="mt-1 text-xs text-muted">{note}</div>
    </div>
  );
}

/** The <768px fallback for the diagram. */
function NodeList({ onSelect }: { onSelect: (id: string) => void }) {
  const nodes = useSentinelStore((s) => s.infraNodes);
  const reduced = useReducedMotion();

  return (
    <ul className="flex flex-col divide-y divide-border">
      {nodes.map((node) => {
        const tone = node.status ? SERVICE_STATUS_TONE[node.status] : "muted";
        const unsettled = node.status !== undefined && node.status !== "healthy";
        return (
          <li key={node.id}>
            <button
              type="button"
              disabled={node.kind === "internet"}
              onClick={() => onSelect(node.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  TONE_DOT[tone],
                  unsettled && !reduced && "animate-pulse",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm text-text", numeric)}>
                  {node.serviceId ?? node.id}
                </span>
                <span className="block truncate text-xs text-muted">
                  {node.kind}
                  {node.metrics
                    ? ` · ${formatCompactNumber(node.metrics.requests)}/min`
                    : ""}
                </span>
              </span>
              {node.metrics ? (
                <span className={cn("shrink-0 text-xs text-text-2", numeric)}>
                  {node.metrics.cpu.toFixed(0)}% · {node.metrics.memory.toFixed(0)}%
                </span>
              ) : (
                <Badge variant={TONE_BADGE.muted} className="font-normal">
                  Edge
                </Badge>
              )}
              {node.status ? (
                <Badge variant={TONE_BADGE[tone]} className="shrink-0 font-normal">
                  {SERVICE_STATUS_LABEL[node.status]}
                </Badge>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
