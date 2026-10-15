"""Static catalogue: monitored services, topology layout, policies, scenarios.

Shapes mirror src/lib/types/index.ts exactly (camelCase keys, epoch ms).
"""

SERVICES = [
    {"id": "api-gateway", "name": "API Gateway", "kind": "gateway", "port": 8080, "throughputUnit": "rpm"},
    {"id": "auth-service", "name": "Auth Service", "kind": "service", "port": 8081, "throughputUnit": "rpm"},
    {"id": "orders-service", "name": "Orders Service", "kind": "service", "port": 8082, "throughputUnit": "rpm"},
    {"id": "payment-worker", "name": "Payment Worker", "kind": "worker", "port": 9110, "throughputUnit": "jobs/min"},
    {"id": "notification-worker", "name": "Notification Worker", "kind": "worker", "port": 9120, "throughputUnit": "jobs/min"},
    {"id": "redis-cache", "name": "Redis Cache", "kind": "cache", "port": 6379, "throughputUnit": "rpm"},
]
SERVICE_IDS = [s["id"] for s in SERVICES]
SERVICE_BY_ID = {s["id"]: s for s in SERVICES}
HTTP_SERVICES = {"api-gateway", "auth-service", "orders-service", "payment-worker", "notification-worker"}

INFRA_NODES = [
    {"id": "internet", "label": "Internet", "kind": "internet", "layout": {"x": 78, "y": 250}},
    {"id": "api-gateway", "label": "API Gateway", "kind": "gateway", "serviceId": "api-gateway", "layout": {"x": 272, "y": 250}},
    {"id": "auth-service", "label": "Auth Service", "kind": "service", "serviceId": "auth-service", "layout": {"x": 500, "y": 98}},
    {"id": "orders-service", "label": "Orders Service", "kind": "service", "serviceId": "orders-service", "layout": {"x": 500, "y": 310}},
    {"id": "payment-worker", "label": "Payment Worker", "kind": "worker", "serviceId": "payment-worker", "layout": {"x": 766, "y": 214}},
    {"id": "notification-worker", "label": "Notification Worker", "kind": "worker", "serviceId": "notification-worker", "layout": {"x": 766, "y": 334}},
    {"id": "postgres", "label": "PostgreSQL", "kind": "database", "layout": {"x": 766, "y": 62}},
    {"id": "redis-cache", "label": "Redis Cache", "kind": "cache", "serviceId": "redis-cache", "layout": {"x": 766, "y": 452}},
]

INFRA_EDGES = [
    {"id": "e-net-gw", "from": "internet", "to": "api-gateway", "kind": "request"},
    {"id": "e-gw-auth", "from": "api-gateway", "to": "auth-service", "kind": "request"},
    {"id": "e-gw-orders", "from": "api-gateway", "to": "orders-service", "kind": "request"},
    {"id": "e-auth-pg", "from": "auth-service", "to": "postgres", "kind": "data"},
    {"id": "e-orders-pg", "from": "orders-service", "to": "postgres", "kind": "data"},
    {"id": "e-orders-redis", "from": "orders-service", "to": "redis-cache", "kind": "cache"},
    {"id": "e-orders-pay", "from": "orders-service", "to": "payment-worker", "kind": "queue"},
    {"id": "e-orders-notif", "from": "orders-service", "to": "notification-worker", "kind": "queue"},
    {"id": "e-pay-pg", "from": "payment-worker", "to": "postgres", "kind": "data"},
]

POLICIES = [
    {
        "id": "CRASH-01", "name": "Service Crash", "trigger": "service_crash",
        "action": "Restart Container", "actionKind": "restart_container", "risk": "safe", "mode": "automatic",
        "description": "Process exited or failed liveness checks. Restart the container in place.",
        "conditions": "signature = service_crash AND match ≥ 0.70 AND restarts_in_window < 2",
    },
    {
        "id": "MEM-LEAK-01", "name": "Memory Leak", "trigger": "memory_growth",
        "action": "Restart Worker", "actionKind": "restart_worker", "risk": "safe", "mode": "automatic",
        "description": "Sustained abnormal memory growth. Recycle the worker to reclaim heap.",
        "conditions": "signature = memory_leak AND match ≥ 0.70 AND restarts_in_window < 2",
    },
    {
        "id": "LATENCY-01", "name": "Latency Degradation", "trigger": "latency_spike",
        "action": "Restart Container", "actionKind": "restart_container", "risk": "safe", "mode": "automatic",
        "description": "Response times far above baseline with a healthy error rate — the request path is stalling, not failing.",
        "conditions": "p95 > 3 × baseline AND error_rate within normal range AND match ≥ 0.70 AND restarts_in_window < 2",
    },
    {
        "id": "CACHE-SAT-01", "name": "Cache Saturation", "trigger": "cache_saturation",
        "action": "Clear Cache", "actionKind": "clear_cache", "risk": "safe", "mode": "automatic",
        "description": "Cache memory pressure with falling hit rate. Evict to relieve pressure.",
        "conditions": "signature = cache_saturation AND hit_rate falling AND match ≥ 0.70 AND actions_in_window < 2",
    },
    {
        "id": "CPU-SAT-01", "name": "CPU Saturation", "trigger": "cpu_saturation",
        "action": "Scale Replicas", "actionKind": "scale_replicas", "risk": "review", "mode": "automatic",
        "description": "Sustained CPU saturation under load. Add a replica to shed pressure.",
        "conditions": "signature = cpu_saturation AND match ≥ 0.70 AND replicas < max_replicas AND actions_in_window < 2",
    },
    {
        "id": "DB-FAIL-01", "name": "Database Failure", "trigger": "db_failure",
        "action": "Alert Operator", "actionKind": "alert_operator", "risk": "restricted", "mode": "manual",
        "description": "Database connectivity or integrity risk. Never auto-remediate — page an operator.",
        "conditions": "signature = db_failure — no automatic action at any match level",
    },
    {
        "id": "UNKNOWN-01", "name": "Unknown Anomaly", "trigger": "unknown",
        "action": "Escalate", "actionKind": "escalate", "risk": "restricted", "mode": "manual",
        "description": "Anomalous behaviour with no matching signature. Escalate for human review.",
        "conditions": "no signature matched OR match < 0.70",
    },
]
POLICY_BY_ID = {p["id"]: p for p in POLICIES}

# Diagnoser fault type -> policy id
FAULT_POLICY = {
    "service_crash": "CRASH-01",
    "memory_leak": "MEM-LEAK-01",
    "latency_spike": "LATENCY-01",
    "cache_saturation": "CACHE-SAT-01",
    "cpu_saturation": "CPU-SAT-01",
    "unknown": "UNKNOWN-01",
}

SCENARIOS = {
    "memory-leak": {
        "title": "Memory Leak", "faultType": "memory_leak", "target": "payment-worker",
        "metric": "memory", "threshold": 90, "thresholdLabel": "memory > 90%", "expected": "auto_heal",
    },
    "unknown-anomaly": {
        "title": "Unknown Anomaly", "faultType": "unknown", "target": "orders-service",
        "metric": "cpu", "threshold": 85, "thresholdLabel": "cpu > 85%", "expected": "escalate",
    },
    "cpu-spike": {
        "title": "CPU Spike", "faultType": "cpu_saturation", "target": "api-gateway",
        "metric": "cpu", "threshold": 85, "thresholdLabel": "cpu > 85%", "expected": "auto_heal",
    },
    "service-crash": {
        "title": "Service Crash", "faultType": "service_crash", "target": "payment-worker",
        "metric": "errorRate", "threshold": 5, "thresholdLabel": "error rate > 5%", "expected": "auto_heal",
    },
    "latency-injection": {
        "title": "Latency Injection", "faultType": "latency_spike", "target": "orders-service",
        "metric": "latencyP95", "threshold": 500, "thresholdLabel": "p95 > 500 ms", "expected": "auto_heal",
    },
    "cache-saturation": {
        "title": "Cache Saturation", "faultType": "cache_saturation", "target": "redis-cache",
        "metric": "memory", "threshold": 90, "thresholdLabel": "memory > 90%", "expected": "auto_heal",
    },
    # The restart clears the symptom but not the bug, which re-emerges once.
    # Earned trust, not a rate limit, is what stops the second blind restart.
    "recurring-leak": {
        "title": "Recurring Leak", "faultType": "memory_leak", "target": "payment-worker",
        "metric": "memory", "threshold": 90, "thresholdLabel": "memory > 90%", "expected": "escalate",
        "recurs": 1,
    },
}

# Static threshold rules: the conventional-alerting baseline the ML detector is
# compared against. A rule must hold for CONSECUTIVE_TO_FIRE samples.
THRESHOLD_RULES = [
    ("cpu", 85.0, "cpu > 85%"),
    ("memory", 90.0, "memory > 90%"),
    ("latencyP95", 500.0, "p95 > 500 ms"),
    ("errorRate", 5.0, "error rate > 5%"),
]

DEFAULT_SETTINGS = {
    "autoRemediation": True,
    "dryRun": False,
    "restartLimit": 2,
    "guardrailWindowSec": 1800,
    "cooldownSec": 120,
    "scrapeIntervalSec": 1,
    "anomalyScan": True,
    "decisionThreshold": 0.7,
    "baselineWindowHours": 24,
    "notifyToasts": True,
    "notifyCriticalOnly": False,
    "verifyAfterRemediation": True,
    "blockRestrictedActions": True,
}

SETTINGS_TYPES = {k: type(v) for k, v in DEFAULT_SETTINGS.items()}
