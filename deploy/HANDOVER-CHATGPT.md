# SentinelOps — ChatGPT / desktop handover

Paste this whole file into ChatGPT (or another assistant) as the system context
for continuing the EC2 deploy. Do **not** paste real passwords or API keys.

---

## Product (one line)

Final-year project: Autonomous Application Monitoring & Self-Healing Operations
Platform. Premium Next.js console + FastAPI live backend that heals a demo
microservices stack via Docker. Spec: `docs/SPEC.md`. Agent rules: `AGENTS.md`.

## Repo

- Local (Windows laptop): `C:\Users\divyaesh.boddu\Desktop\sentinelops`
- GitHub: `https://github.com/vaishnav-999/sentinelops.git` (branch `main`)
- Latest meaningful commits:
  - `9227492` — earned autonomy, relapse, blast radius, grounded AI, recurring-leak
  - `b9435b0` — live FastAPI, Docker heal loop, auth, EC2 deploy, Gemini, eval
- Server clone: `/home/ubuntu/sentinelops` on EC2
- **Never commit** `deploy/sentinel.env` or `.env.local`

## AWS EC2 (current)

| Item | Value |
|---|---|
| Region | `ap-south-1` |
| Instance | `i-0ece1ed80bedf1769` (t3.small + 4G swap) |
| Public IP (earlier) | `13.202.51.70` — **re-check in console**; may change without Elastic IP |
| OS | Ubuntu |
| Access | **AWS Session Manager** (SSH port 22 often blocked — SG “My IP” goes stale on hotspot) |
| Security group | `sentinelops-sg`: 80/443 open; 22 only to a specific /32; do **not** open 8000/8080/5432 |
| Swap | `/swapfile` 4G present |

## What already works on EC2

1. Docker + Compose installed; 4G swap OK.
2. `deploy/sentinel.env` exists (`chmod 600`), filled with admin password, session secret, Gemini key, etc.
3. Images built; full stack started via:
   ```bash
   docker compose --env-file deploy/sentinel.env \
     -f docker-compose.live.yml -f docker-compose.prod.yml up -d --build
   ```
4. Containers up: `so-postgres`, `so-sentinel-db`, `so-redis-cache`, target services,
   `so-backend`, `so-web`, `so-caddy`, `so-loadgen`, etc.
5. Backend health OK:
   ```bash
   curl http://127.0.0.1:8000/api/healthz
   # → {"ok":true}
   ```

## What is broken right now (root cause)

`deploy/sentinel.env` still has the **example** site IP:

```text
SENTINEL_SITE=203.0.113.10   # ← DOCUMENTATION PLACEHOLDER, NOT THE EC2 IP
SENTINEL_TLS=internal
```

Caddy only terminates TLS for `{$SENTINEL_SITE}` (`deploy/Caddyfile`). With the
wrong IP:

- `curl -k https://localhost/...` → TLS alert (SNI mismatch)
- `curl` with `--resolve 203.0.113.10:443:127.0.0.1` → still fails / useless
- Browser cannot open the real machine as `https://203.0.113.10`

Also: every Compose command **must** use `--env-file deploy/sentinel.env` or
interpolation fails (`SENTINEL_SITE` / password / session secret missing).

Earlier build failure (`npm ci` missing `@emnapi/core|runtime`) was worked around
on the server (lockfile refresh / `npm install`). Laptop cannot reliably refresh
`package-lock.json` (corporate TLS: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). Prefer
fixing lockfile on EC2 or Linux CI, not on the corp Windows laptop.

## Immediate next steps (EC2 Session Manager)

```bash
cd /home/ubuntu/sentinelops

# 1) Discover the real public IPv4
curl -s http://checkip.amazonaws.com
# Or: curl -s http://169.254.169.254/latest/meta-data/public-ipv4

# 2) Edit env — set SENTINEL_SITE to THAT IP (not 203.0.113.10)
nano deploy/sentinel.env
# SENTINEL_SITE=<public-ip>
# SENTINEL_TLS=internal

# 3) Recreate Caddy (and anything that reads SENTINEL_SITE) with the env file
docker compose --env-file deploy/sentinel.env \
  -f docker-compose.live.yml -f docker-compose.prod.yml up -d

# 4) Verify
SITE=$(grep '^SENTINEL_SITE=' deploy/sentinel.env | cut -d= -f2- | tr -d '"' | tr -d "'")
echo "SITE=$SITE"
curl http://127.0.0.1:8000/api/healthz
curl -k --resolve "${SITE}:443:127.0.0.1" "https://${SITE}/api/healthz"
curl -k --resolve "${SITE}:443:127.0.0.1" -o /dev/null -w '%{http_code}\n' "https://${SITE}/api/status"
# Expect: {"ok":true} and HTTP 401 for /api/status

docker logs so-caddy --tail 50
docker logs so-backend --tail 30
```

### Browser (laptop)

1. Open `https://<public-ip>` (same as `SENTINEL_SITE`).
2. Accept the self-signed cert warning (`SENTINEL_TLS=internal`).
3. Sign in with `SENTINEL_ADMIN_USER` / `SENTINEL_ADMIN_PASSWORD` from the env file
   (read on server only — do not paste secrets into ChatGPT).
4. Overview should show live services. ML learns ~4 minutes (“Learning baseline”).
5. Chaos Lab → run a scenario (e.g. Service crash) → incident → remediate ~30s.
6. Resolved incident → “Generate report” (Gemini or Deterministic fallback).

If the page does not load: check SG allows **your current** public IP on 443
(or 0.0.0.0/0 for 443). Hotspot IP changes often.

## Compose rule (never forget)

```bash
docker compose --env-file deploy/sentinel.env \
  -f docker-compose.live.yml -f docker-compose.prod.yml <subcommand>
```

Useful:

| Task | Command |
|---|---|
| Status | `... ps` |
| Rebuild after pull | `... up -d --build` |
| Backend logs | `docker logs -f so-backend` |
| Caddy logs | `docker logs -f so-caddy` |
| Stop | `... stop` |

## How to continue from the Windows desktop

### A) Operate the **already-running EC2** stack (recommended)

You do **not** need Docker on the laptop for the live demo.

1. AWS Console → EC2 → instance → **Connect → Session Manager**.
2. Or, if SG “My IP” matches your home/office IP and key works:
   ```powershell
   ssh -i path\to\key.pem ubuntu@<public-ip>
   ```
3. Fix `SENTINEL_SITE`, recreate stack, open browser to `https://<public-ip>`.

Optional: assign an **Elastic IP** so the address (and `SENTINEL_SITE`) stop changing.

### B) Run the **full live stack on the desktop** (Docker Desktop)

Needs Docker Desktop with enough RAM (prefer ≥8 GB for Docker; 4 GB host is tight).

```powershell
cd C:\Users\divyaesh.boddu\Desktop\sentinelops
copy deploy\sentinel.env.example deploy\sentinel.env
# Edit deploy\sentinel.env:
#   SENTINEL_SITE=localhost
#   SENTINEL_TLS=internal
#   fill SENTINEL_ADMIN_PASSWORD, SENTINEL_SESSION_SECRET
#   optional GEMINI_API_KEY

docker compose --env-file deploy/sentinel.env `
  -f docker-compose.live.yml -f docker-compose.prod.yml up -d --build
```

Then open `https://localhost` (accept cert warning).  
Corporate proxy/TLS may break `npm`/`docker pull` on this laptop — if builds fail
with cert errors, stay on EC2.

### C) Frontend-only demo (simulation, no Docker heal loop)

```powershell
cd C:\Users\divyaesh.boddu\Desktop\sentinelops
npm install
npm run dev
```

Open `http://localhost:3000`. This is the **simulated** console, not the live
EC2 self-healing deploy.

### D) ChatGPT continuation checklist

Ask the next assistant to:

1. Confirm `SENTINEL_SITE` equals current EC2 public IPv4 (not `203.0.113.10`).
2. Recreate compose with `--env-file`.
3. Verify healthz via `--resolve` and browser login.
4. Walk Chaos Lab + incident report.
5. Optionally: Elastic IP, domain + `SENTINEL_TLS=auto`, eval campaigns
   (`docs` / evaluate harness), paper metrics (never invent F1/MTTR — show “—”).

## Architecture reminders (do not break)

- Simulation engine owns timers in the frontend demo; live mode uses FastAPI + Docker.
- LLM (Gemini) writes explanations only — never decides/executes remediation.
- Always `--env-file deploy/sentinel.env` for prod compose.
- Academic honesty: show Demo/Simulated markers; research metrics “—” until evaluated.
- Stack: Next.js App Router, Tailwind/shadcn, Zustand, Recharts, Motion, FastAPI backend.

## Known gaps / landmines

1. **Wrong `SENTINEL_SITE`** — blocking HTTPS right now.
2. **SG My IP** — Session Manager preferred when SSH times out.
3. **t3.small memory** — keep 4G swap; avoid concurrent heavy builds.
4. **Corporate laptop npm TLS** — do not rely on refreshing `package-lock.json` there.
5. **Local `package-lock.json`** may be dirty/out of sync with `@emnapi`; server
   workaround already used for web image build.
6. User commits themselves after phases — assistants should **not** `git commit`
   or `git push` unless explicitly asked.

## Secrets policy for ChatGPT

Never paste into chat:

- `SENTINEL_ADMIN_PASSWORD`
- `SENTINEL_SESSION_SECRET`
- `GEMINI_API_KEY`
- AWS access keys
- Contents of `deploy/sentinel.env` or `.env.local`

Safe to share: public IP, instance id, compose `ps` output, redacted logs,
curl status codes, this handover file.

---

## One-shot prompt to paste into ChatGPT

```
You are continuing a SentinelOps EC2 deploy. Read deploy/HANDOVER-CHATGPT.md
context I pasted. Current blocker: SENTINEL_SITE is still 203.0.113.10 (example
IP) while the stack is otherwise up and curl http://127.0.0.1:8000/api/healthz
returns {"ok":true}. Guide me step-by-step (beginner) to set SENTINEL_SITE to
the real public IP, recreate compose with --env-file deploy/sentinel.env, verify
HTTPS, then browser login and Chaos Lab. Do not ask me to paste secrets. Prefer
AWS Session Manager commands. I am on my Windows desktop continuing via browser
+ Session Manager.
```
