"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { SERVICE_STATUS_TONE, TONE_DOT } from "@/lib/tone";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type { InfraEdge, InfraNode, ServiceStatus } from "@/lib/types";

/**
 * The live system map: plain SVG lines under absolutely positioned HTML nodes.
 * No graph library — the topology is fixed, so the only thing worth computing
 * at runtime is colour, and that comes straight out of the store.
 *
 * Both layers share the 900×500 coordinate space: the SVG stretches with
 * `preserveAspectRatio="none"` and the node boxes are positioned by the same
 * percentages, so a line can never miss the box it points at.
 */

const CANVAS_W = 900;
const CANVAS_H = 500;

const EDGE_LABEL: Record<NonNullable<InfraEdge["kind"]>, string> = {
  request: "http",
  data: "sql",
  cache: "cache",
  queue: "queue",
};

/** The worst status either end of an edge is in decides its colour. */
function edgeTone(a?: ServiceStatus, b?: ServiceStatus): "muted" | "warn" | "crit" {
  const worst = [a, b];
  if (worst.includes("critical")) return "crit";
  if (worst.includes("degraded") || worst.includes("recovering")) return "warn";
  return "muted";
}

const EDGE_STROKE = {
  muted: "var(--border-strong)",
  warn: "var(--warn)",
  crit: "var(--crit)",
} as const;

export function TopologyMap({
  onSelect,
}: {
  onSelect: (nodeId: string) => void;
}) {
  const nodes = useSentinelStore((s) => s.infraNodes);
  const edges = useSentinelStore((s) => s.infraEdges);
  const reduced = useReducedMotion();

  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div
      className="relative w-full"
      style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}`, minHeight: 440 }}
    >
      <svg
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const tone = edgeTone(from.status, to.status);
          const midX = (from.layout.x + to.layout.x) / 2;
          const midY = (from.layout.y + to.layout.y) / 2;
          return (
            <g key={edge.id}>
              <line
                x1={from.layout.x}
                y1={from.layout.y}
                x2={to.layout.x}
                y2={to.layout.y}
                stroke={EDGE_STROKE[tone]}
                strokeWidth={2}
                strokeDasharray={edge.kind === "queue" ? "5 4" : undefined}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={midX}
                cy={midY}
                r={3}
                fill={EDGE_STROKE[tone]}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>

      {/* Edge kind labels sit in HTML so they keep their 12px size at any width. */}
      {edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to || edge.kind === undefined) return null;
        const x = (from.layout.x + to.layout.x) / 2;
        const y = (from.layout.y + to.layout.y) / 2;
        return (
          <span
            key={`${edge.id}-label`}
            className={cn(
              "pointer-events-none absolute -translate-x-1/2 translate-y-2 bg-panel px-1 text-xs text-muted",
              numeric,
            )}
            style={{
              left: `${(x / CANVAS_W) * 100}%`,
              top: `${(y / CANVAS_H) * 100}%`,
            }}
          >
            {EDGE_LABEL[edge.kind]}
          </span>
        );
      })}

      {nodes.map((node) => (
        <NodeBox
          key={node.id}
          node={node}
          reduced={reduced}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function NodeBox({
  node,
  reduced,
  onSelect,
}: {
  node: InfraNode;
  reduced: boolean;
  onSelect: (id: string) => void;
}) {
  const tone = node.status ? SERVICE_STATUS_TONE[node.status] : "muted";
  const unsettled = node.status !== undefined && node.status !== "healthy";

  if (node.kind === "internet") {
    return (
      <div
        className="absolute flex h-14 w-[124px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-dashed border-border bg-panel text-sm text-text-2"
        style={{
          left: `${(node.layout.x / CANVAS_W) * 100}%`,
          top: `${(node.layout.y / CANVAS_H) * 100}%`,
        }}
      >
        {node.label}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      aria-label={`${node.label} details`}
      className={cn(
        "absolute flex w-[164px] -translate-x-1/2 -translate-y-1/2 flex-col gap-1 rounded-md border bg-panel px-3 py-2 text-left outline-none",
        "hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50",
        !reduced && "transition-colors duration-150 ease-out",
        unsettled ? "border-border-strong" : "border-border",
      )}
      style={{
        left: `${(node.layout.x / CANVAS_W) * 100}%`,
        top: `${(node.layout.y / CANVAS_H) * 100}%`,
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            TONE_DOT[tone],
            unsettled && !reduced && "animate-pulse",
          )}
        />
        <span className={cn("truncate text-sm text-text", numeric)}>
          {node.serviceId ?? node.id}
        </span>
      </span>
      <span className={cn("flex items-center gap-3 text-xs text-muted", numeric)}>
        <span>CPU {node.metrics ? node.metrics.cpu.toFixed(0) : "—"}%</span>
        <span>MEM {node.metrics ? node.metrics.memory.toFixed(0) : "—"}%</span>
      </span>
    </button>
  );
}
