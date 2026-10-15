import os

SENTINEL_DB_DSN = os.environ.get("SENTINEL_DB_DSN", "")
TARGET_PG_DSN = os.environ.get("TARGET_PG_DSN", "")
REDIS_HOST = os.environ.get("REDIS_HOST", "redis-cache")
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",")
    if o.strip()
]

# Auth: on only when an admin password is set (always on a server).
ADMIN_USER = os.environ.get("SENTINEL_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("SENTINEL_ADMIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("SENTINEL_SESSION_SECRET", "")
SESSION_TTL_SEC = int(os.environ.get("SENTINEL_SESSION_TTL_SEC", str(12 * 3600)))
# Set to 1 behind HTTPS so the session cookie is never sent over plain HTTP.
COOKIE_SECURE = os.environ.get("SENTINEL_COOKIE_SECURE", "0") == "1"
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SEC = 300

TICK_SEC = 1.0
PROBE_TIMEOUT_SEC = 0.8

# Detection
WARMUP_SAMPLES = 240
RETRAIN_EVERY_SAMPLES = 300
ML_FIRE_SCORE = 0.6
ML_CLEAR_SCORE = 0.5
# At least one metric this many σ worse than baseline (std floors applied).
ML_MIN_EFFECT_Z = 4.0
ML_CONSECUTIVE_TO_FIRE = 5
CONSECUTIVE_TO_FIRE = 3
# Covers the target apps' 20 s rolling latency window plus slow first requests.
STARTUP_GRACE_SEC = 30
# Detection is held this long after the backend boots (dependencies settling).
BOOT_GRACE_SEC = 45
# A gap this long between 1 s ticks means the host paused or starved the
# Docker VM (sleep, throttling); every service then gets the startup grace.
STALL_GAP_SEC = 5
# This many independently degraded services at once = host-wide event.
SYSTEMIC_MIN_ROOTS = 3
SYSTEMIC_HOLD_SEC = 30
# Earned autonomy (trust.py): Beta prior worth 4 successes / 1 failure, so a
# new (policy, service) pair starts at 0.80 and loses autonomy at its first
# relapse (0.67), while a pair with one durable fix survives one (0.71).
TRUST_PRIOR_SUCCESS = 4.0
TRUST_PRIOR_FAILURE = 1.0
TRUST_FLOOR = 0.7
# A fix is durable if the same fault does not return within this window.
RELAPSE_WINDOW_SEC = 600
# Recurring-leak scenario: delay before the persisting bug re-emerges.
RELAPSE_REINJECT_SEC = 12
# A service escalated to the operator this recently is a known fault, not a
# new independent root.
ESCALATION_MEMORY_SEC = 600
# A dependency restarted this recently still explains its callers' errors.
DEPENDENCY_SETTLE_SEC = 30

# Chaos runs
COUNTDOWN_SEC = 3
DETECTION_TIMEOUT_SEC = 90
VERIFY_TIMEOUT_SEC = 60
VERIFY_PASSES = 5
MAX_REPLICAS = 3

# Evaluation: research metrics stay null until this many finished runs exist.
MIN_RUNS_FOR_EVALUATION = 5
MIN_PAIRED_RUNS_FOR_MTTD = 3
