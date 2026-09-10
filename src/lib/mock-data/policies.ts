import type { RemediationPolicy } from "@/lib/types";

/**
 * Seven remediation policies (SPEC §12). Five run automatically for safe/known
 * faults; the last two require manual approval. Risk badges: safe (auto, low
 * blast radius), review (auto but changes infra), restricted (never auto — an
 * operator decides).
 *
 * `conditions` is the rule the Diagnoser's output is actually tested against,
 * shown verbatim in the expanded policy row. Every automatic policy carries the
 * `restarts_in_window` clause because the guardrail is part of the policy, not
 * an afterthought bolted on around it.
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
    conditions:
      "signature = service_crash AND match ≥ 0.70 AND restarts_in_window < 2",
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
    conditions:
      "signature = memory_leak AND match ≥ 0.70 AND restarts_in_window < 2",
  },
  {
    id: "LATENCY-01",
    name: "Latency Degradation",
    trigger: "latency_spike",
    action: "Restart Container",
    actionKind: "restart_container",
    risk: "safe",
    mode: "automatic",
    description:
      "Response times far above baseline with a healthy error rate — the request path is stalling, not failing.",
    conditions:
      "p95 > 3 × baseline AND error_rate within normal range AND match ≥ 0.70 AND restarts_in_window < 2",
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
    conditions:
      "signature = cache_saturation AND hit_rate falling AND match ≥ 0.70 AND actions_in_window < 2",
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
    conditions:
      "signature = cpu_saturation AND match ≥ 0.70 AND replicas < max_replicas AND actions_in_window < 2",
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
    conditions: "signature = db_failure — no automatic action at any match level",
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
    conditions: "no signature matched OR match < 0.70",
  },
];

export function cloneSeedPolicies(): RemediationPolicy[] {
  return SEED_POLICIES.map((p) => ({ ...p }));
}
