import type { RemediationPolicy } from "@/lib/types";

/**
 * Six remediation policies (SPEC §12). The first four run automatically for
 * safe/known faults; the last two require manual approval. Risk badges:
 * safe (auto, low blast radius), review (auto but changes infra), restricted
 * (never auto — operator decides).
 */
export const SEED_POLICIES: RemediationPolicy[] = [
  {
    id: "CRASH-01",
    name: "Service Crash",
    trigger: "service_crash",
    action: "Restart Container",
    actionKind: "restart_container",
    risk: "safe",
    mode: "automatic",
    description:
      "Process exited or failed liveness checks. Restart the container in place.",
  },
  {
    id: "MEM-LEAK-01",
    name: "Memory Leak",
    trigger: "memory_growth",
    action: "Restart Worker",
    actionKind: "restart_worker",
    risk: "safe",
    mode: "automatic",
    description:
      "Sustained abnormal memory growth. Recycle the worker to reclaim heap.",
  },
  {
    id: "CACHE-SAT-01",
    name: "Cache Saturation",
    trigger: "cache_saturation",
    action: "Clear Cache",
    actionKind: "clear_cache",
    risk: "safe",
    mode: "automatic",
    description:
      "Cache memory pressure with falling hit rate. Evict to relieve pressure.",
  },
  {
    id: "CPU-SAT-01",
    name: "CPU Saturation",
    trigger: "cpu_saturation",
    action: "Scale Replicas",
    actionKind: "scale_replicas",
    risk: "review",
    mode: "automatic",
    description:
      "Sustained CPU saturation under load. Add a replica to shed pressure.",
  },
  {
    id: "DB-FAIL-01",
    name: "Database Failure",
    trigger: "db_failure",
    action: "Alert Operator",
    actionKind: "alert_operator",
    risk: "restricted",
    mode: "manual",
    description:
      "Database connectivity or integrity risk. Never auto-remediate — page an operator.",
  },
  {
    id: "UNKNOWN-01",
    name: "Unknown Anomaly",
    trigger: "unknown",
    action: "Escalate",
    actionKind: "escalate",
    risk: "restricted",
    mode: "manual",
    description:
      "Anomalous behaviour with no matching signature. Escalate for human review.",
  },
];

export function cloneSeedPolicies(): RemediationPolicy[] {
  return SEED_POLICIES.map((p) => ({ ...p }));
}
