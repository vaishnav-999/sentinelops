import type { InfraEdge, InfraNode } from "@/lib/types";

/**
 * System topology for the Infrastructure page. Services link to their seed
 * ids; PostgreSQL is the sole database node, Redis the sole cache node.
 *
 *   Internet → API Gateway → Auth / Orders
 *   Orders → Payment Worker → PostgreSQL / Redis
 *   Orders → Notification Worker
 *   Auth / Orders / Payment → PostgreSQL
 *   Auth / Orders / Notification → Redis
 */
export const SEED_INFRA_NODES: InfraNode[] = [
  { id: "internet", label: "Internet", kind: "internet" },
  {
    id: "api-gateway",
    label: "API Gateway",
    kind: "gateway",
    serviceId: "api-gateway",
    meta: { port: 8080, containerId: "3f9a1c7e2b04", image: "sentinelops/api-gateway:2.4.1" },
  },
  {
    id: "auth-service",
    label: "Auth Service",
    kind: "service",
    serviceId: "auth-service",
    meta: { port: 8081, containerId: "a7e04c2f18d9", image: "sentinelops/auth-service:1.9.3" },
  },
  {
    id: "orders-service",
    label: "Orders Service",
    kind: "service",
    serviceId: "orders-service",
    meta: { port: 8082, containerId: "5c1b9d3e7a26", image: "sentinelops/orders-service:3.1.0" },
  },
  {
    id: "payment-worker",
    label: "Payment Worker",
    kind: "worker",
    serviceId: "payment-worker",
    meta: { port: 9110, containerId: "9d40b7c1e5a8", image: "sentinelops/payment-worker:2.2.7" },
  },
  {
    id: "notification-worker",
    label: "Notification Worker",
    kind: "worker",
    serviceId: "notification-worker",
    meta: { port: 9120, containerId: "47a1e9c02f6b", image: "sentinelops/notification-worker:1.5.2" },
  },
  {
    id: "redis-cache",
    label: "Redis Cache",
    kind: "cache",
    serviceId: "redis-cache",
    meta: { port: 6379, containerId: "b6c3f0a75e19", image: "redis:7.2-alpine" },
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    kind: "database",
    meta: { port: 5432, containerId: "d0a91c3f4b72", image: "postgres:16.2-alpine" },
  },
];

export const SEED_INFRA_EDGES: InfraEdge[] = [
  { id: "e-net-gw", from: "internet", to: "api-gateway", kind: "request" },
  { id: "e-gw-auth", from: "api-gateway", to: "auth-service", kind: "request" },
  { id: "e-gw-orders", from: "api-gateway", to: "orders-service", kind: "request" },
  { id: "e-orders-pay", from: "orders-service", to: "payment-worker", kind: "request" },
  { id: "e-orders-notif", from: "orders-service", to: "notification-worker", kind: "request" },
  { id: "e-auth-pg", from: "auth-service", to: "postgres", kind: "data" },
  { id: "e-orders-pg", from: "orders-service", to: "postgres", kind: "data" },
  { id: "e-pay-pg", from: "payment-worker", to: "postgres", kind: "data" },
  { id: "e-auth-redis", from: "auth-service", to: "redis-cache", kind: "cache" },
  { id: "e-orders-redis", from: "orders-service", to: "redis-cache", kind: "cache" },
  { id: "e-notif-redis", from: "notification-worker", to: "redis-cache", kind: "cache" },
];

export function cloneSeedInfraNodes(): InfraNode[] {
  return SEED_INFRA_NODES.map((n) => ({
    ...n,
    meta: n.meta ? { ...n.meta } : undefined,
  }));
}

export function cloneSeedInfraEdges(): InfraEdge[] {
  return SEED_INFRA_EDGES.map((e) => ({ ...e }));
}
