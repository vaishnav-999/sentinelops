import type { Container } from "@/lib/types";
import { HOUR, SEED_NOW } from "./constants";
import { SEED_SERVICES } from "./services";

/**
 * Eight running app containers backing the six services (orders + gateway run
 * two replicas each). PostgreSQL and Redis are represented as infra nodes;
 * Redis also runs as the `redis-cache` service container below.
 */
export const SEED_CONTAINERS: Container[] = [
  {
    id: "3f9a1c7e2b04",
    name: "api-gateway-1",
    image: "sentinelops/api-gateway:2.4.1",
    serviceId: "api-gateway",
    status: "running",
    cpu: 48,
    memory: 61,
    createdAt: SEED_NOW - 32 * HOUR,
  },
  {
    id: "8b2d5f0a9c31",
    name: "api-gateway-2",
    image: "sentinelops/api-gateway:2.4.1",
    serviceId: "api-gateway",
    status: "running",
    cpu: 45,
    memory: 58,
    createdAt: SEED_NOW - 32 * HOUR,
  },
  {
    id: "a7e04c2f18d9",
    name: "auth-service-1",
    image: "sentinelops/auth-service:1.9.3",
    serviceId: "auth-service",
    status: "running",
    cpu: 31,
    memory: 54,
    createdAt: SEED_NOW - 54 * HOUR,
  },
  {
    id: "5c1b9d3e7a26",
    name: "orders-service-1",
    image: "sentinelops/orders-service:3.1.0",
    serviceId: "orders-service",
    status: "running",
    cpu: 57,
    memory: 66,
    createdAt: SEED_NOW - 26 * HOUR,
  },
  {
    id: "e2f83a0c4b17",
    name: "orders-service-2",
    image: "sentinelops/orders-service:3.1.0",
    serviceId: "orders-service",
    status: "running",
    cpu: 52,
    memory: 63,
    createdAt: SEED_NOW - 26 * HOUR,
  },
  {
    id: "9d40b7c1e5a8",
    name: "payment-worker-1",
    image: "sentinelops/payment-worker:2.2.7",
    serviceId: "payment-worker",
    status: "running",
    cpu: 42,
    memory: 59,
    createdAt: SEED_NOW - 18 * HOUR,
  },
  {
    id: "47a1e9c02f6b",
    name: "notification-worker-1",
    image: "sentinelops/notification-worker:1.5.2",
    serviceId: "notification-worker",
    status: "running",
    cpu: 24,
    memory: 41,
    createdAt: SEED_NOW - 41 * HOUR,
  },
  {
    id: "b6c3f0a75e19",
    name: "redis-cache-1",
    image: "redis:7.2-alpine",
    serviceId: "redis-cache",
    status: "running",
    cpu: 18,
    memory: 63,
    createdAt: SEED_NOW - 63 * HOUR,
  },
];

/**
 * Replica share of a service's throughput. `api-gateway` and `orders-service`
 * run two containers each, so a single container handles roughly half.
 */
const REPLICAS: Record<string, number> = {
  "api-gateway": 2,
  "orders-service": 2,
};

export function cloneSeedContainers(): Container[] {
  return SEED_CONTAINERS.map((c) => {
    const svc = SEED_SERVICES.find((s) => s.id === c.serviceId);
    const replicas = c.serviceId ? (REPLICAS[c.serviceId] ?? 1) : 1;
    return {
      ...c,
      port: svc?.port,
      requests: svc ? Math.round(svc.baseline.throughput / replicas) : undefined,
      heartbeatAt: SEED_NOW,
    };
  });
}
