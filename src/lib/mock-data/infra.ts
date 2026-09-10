import type { InfraEdge, InfraNode } from "@/lib/types";
import { SEED_SERVICES } from "./services";
import { SEED_NOW } from "./constants";

/**
 * System topology for the Infrastructure page.
 *
 *   Internet → API Gateway → Auth Service / Orders Service
 *   Orders Service → PostgreSQL / Redis Cache
 *   Orders Service ⇢ Payment Worker / Notification Worker  (queue)
 *   Auth Service → PostgreSQL,  Payment Worker → PostgreSQL
 *
 * `layout` is in the fixed 900×500 canvas the map is drawn in; the SVG edge
 * layer uses the same viewBox, so a node box and the line reaching it can
 * never drift apart. Positions are chosen so no edge passes under a box.
 */
export const SEED_INFRA_NODES: InfraNode[] = [
  {
    id: "internet",
    label: "Internet",
    kind: "internet",
    layout: { x: 78, y: 250 },
  },
  {
    id: "api-gateway",
    label: "API Gateway",
    kind: "gateway",
    serviceId: "api-gateway",
    layout: { x: 272, y: 250 },
    meta: { port: 8080, containerId: "3f9a1c7e2b04", image: "sentinelops/api-gateway:2.4.1" },
  },
  {
    id: "auth-service",
    label: "Auth Service",
    kind: "service",
    serviceId: "auth-service",
    layout: { x: 500, y: 98 },
    meta: { port: 8081, containerId: "a7e04c2f18d9", image: "sentinelops/auth-service:1.9.3" },
  },
  {
    id: "orders-service",
    label: "Orders Service",
    kind: "service",
    serviceId: "orders-service",
    layout: { x: 500, y: 310 },
    meta: { port: 8082, containerId: "5c1b9d3e7a26", image: "sentinelops/orders-service:3.1.0" },
  },
  {
    id: "payment-worker",
    label: "Payment Worker",
    kind: "worker",
    serviceId: "payment-worker",
    layout: { x: 766, y: 214 },
    meta: { port: 9110, containerId: "9d40b7c1e5a8", image: "sentinelops/payment-worker:2.2.7" },
  },
  {
    id: "notification-worker",
    label: "Notification Worker",
    kind: "worker",
    serviceId: "notification-worker",
    layout: { x: 766, y: 334 },
    meta: { port: 9120, containerId: "47a1e9c02f6b", image: "sentinelops/notification-worker:1.5.2" },
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    kind: "database",
    layout: { x: 766, y: 62 },
    meta: { port: 5432, containerId: "d0a91c3f4b72", image: "postgres:16.2-alpine" },
  },
  {
    id: "redis-cache",
    label: "Redis Cache",
    kind: "cache",
    serviceId: "redis-cache",
    layout: { x: 766, y: 452 },
    meta: { port: 6379, containerId: "b6c3f0a75e19", image: "redis:7.2-alpine" },
  },
];

export const SEED_INFRA_EDGES: InfraEdge[] = [
  { id: "e-net-gw", from: "internet", to: "api-gateway", kind: "request" },
  { id: "e-gw-auth", from: "api-gateway", to: "auth-service", kind: "request" },
  { id: "e-gw-orders", from: "api-gateway", to: "orders-service", kind: "request" },
  { id: "e-auth-pg", from: "auth-service", to: "postgres", kind: "data" },
  { id: "e-orders-pg", from: "orders-service", to: "postgres", kind: "data" },
  { id: "e-orders-redis", from: "orders-service", to: "redis-cache", kind: "cache" },
  { id: "e-orders-pay", from: "orders-service", to: "payment-worker", kind: "queue" },
  { id: "e-orders-notif", from: "orders-service", to: "notification-worker", kind: "queue" },
  { id: "e-pay-pg", from: "payment-worker", to: "postgres", kind: "data" },
];

/** Steady-state figures for the PostgreSQL node, which has no Service record. */
export const POSTGRES_BASELINE = { cpu: 26, memory: 48, requests: 1840 } as const;

/**
 * Fresh nodes for the store. Service-backed nodes start on their service's
 * healthy baseline rather than at zero, so the map renders real figures on the
 * very first paint (and identically on the server) instead of flashing 0%.
 */
export function cloneSeedInfraNodes(): InfraNode[] {
  return SEED_INFRA_NODES.map((n) => {
    const svc = SEED_SERVICES.find((s) => s.id === n.serviceId);
    return {
      ...n,
      layout: { ...n.layout },
      meta: n.meta ? { ...n.meta } : undefined,
      status: svc?.status,
      heartbeatAt: n.kind === "internet" ? undefined : SEED_NOW,
      metrics:
        n.kind === "internet"
          ? undefined
          : svc
            ? {
                cpu: svc.baseline.cpu,
                memory: svc.baseline.memory,
                requests: svc.baseline.throughput,
              }
            : { ...POSTGRES_BASELINE },
    };
  });
}

export function cloneSeedInfraEdges(): InfraEdge[] {
  return SEED_INFRA_EDGES.map((e) => ({ ...e }));
}
