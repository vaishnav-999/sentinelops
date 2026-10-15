# Deploying SentinelOps on AWS EC2 (Ubuntu)

One server runs everything: the demo target system, the SentinelOps backend,
the console, and Caddy (HTTPS). Only ports 80/443 are public. The backend holds
the Docker socket (root-equivalent), so it stays on 127.0.0.1 and every request
needs a signed-in session.

## 1. Instance

- Ubuntu 22.04 or 24.04, x86_64 or arm64.
- Size: `t3.medium` (2 vCPU, 4 GB) recommended. `t3.small` (2 GB) works with
  the swap file below. `t2.micro`/`t3.micro` (1 GB) is too small.
- Disk: 20 GB gp3.
- Security group inbound rules:

| Port | Source | Why |
|---|---|---|
| 22 | My IP | SSH |
| 80 | 0.0.0.0/0 | HTTP → HTTPS redirect, Let's Encrypt challenge |
| 443 | 0.0.0.0/0 | Console |

Do **not** open 8000, 8080 or 5432.

Optional: attach an Elastic IP so the address survives stop/start.

## 2. Install Docker

```bash
ssh -i your-key.pem ubuntu@<public-ip>

sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit   # log out and back in so the group applies
```

Check: `docker run --rm hello-world` and `docker compose version` (v2.20+).

## 3. Swap (needed on 2 GB instances, harmless on 4 GB)

The Next.js production build needs ~1.5 GB of memory on top of the running stack.

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Get the code

```bash
git clone <your-repo-url> sentinelops
cd sentinelops
```

(Or copy it up with `scp -r` / `rsync`, excluding `node_modules`, `.next` and `.env*`.)

## 5. Configure

```bash
cp deploy/sentinel.env.example deploy/sentinel.env
chmod 600 deploy/sentinel.env
openssl rand -base64 18   # use as SENTINEL_ADMIN_PASSWORD
openssl rand -base64 48   # use as SENTINEL_SESSION_SECRET
nano deploy/sentinel.env
```

Choose one:

- **Bare IP** (no domain): `SENTINEL_SITE=<public-ip>` and `SENTINEL_TLS=internal`.
  Caddy issues a self-signed certificate; the browser shows a warning once,
  which you accept.
- **Domain**: point an A record at the public IP first, then
  `SENTINEL_SITE=sentinel.example.com` and `SENTINEL_TLS=auto`. Caddy gets a
  Let's Encrypt certificate automatically (ports 80 and 443 must be open).

Optional Gemini reports: set `GEMINI_API_KEY` (and `GEMINI_MODEL` if you use a
different model). The key stays on the server; without it, incidents get the
deterministic report.

`deploy/sentinel.env` is git-ignored. Never commit it.

Not sure which instance size you have? Run `nproc && free -h` on the server, or
check "Instance type" in the EC2 console.

## 6. Start

```bash
docker compose --env-file deploy/sentinel.env \
  -f docker-compose.live.yml -f docker-compose.prod.yml up -d --build
```

The first build takes 5–10 minutes on a small instance.

## 7. Verify

```bash
docker compose -f docker-compose.live.yml -f docker-compose.prod.yml ps
curl -k https://localhost/api/healthz        # {"ok":true}
curl -k -o /dev/null -w '%{http_code}\n' https://localhost/api/status   # 401 (signed out)
docker logs so-backend --tail 30
```

In a browser, open `https://<SENTINEL_SITE>`:

1. The sign-in form appears. Sign in with the admin user and password.
2. Overview shows live services. The ML models learn a healthy baseline for
   about 4 minutes ("Learning baseline · n/240 samples" on ML insights).
3. After training, open Chaos Lab and run a scenario (for example Service crash).
   An incident opens, is diagnosed, remediated and verified within ~30 s.
4. Open the resolved incident and click "Generate report". With a Gemini key
   the badge reads "Gemini"; without one, "Deterministic".
5. Sign out from the avatar menu.

## 8. Operating it

| Task | Command |
|---|---|
| Logs | `docker logs -f so-backend` |
| Update after `git pull` | rerun the step 6 command |
| Stop | `docker compose -f docker-compose.live.yml -f docker-compose.prod.yml stop` |
| Restart after a reboot | rerun the step 6 command (target services use `restart: "no"` on purpose, so a crash stays down until SentinelOps heals it) |
| Reset demo state | Settings → Reset, or `POST /api/system/reset` while signed in |

Trained baselines, incidents and experiment history live in the `sentinel-data`
volume and survive restarts.

## 9. Private alternative

To keep the console off the public internet (for example before a demo), use
the bare-IP setup and set the 443 rule's source to **My IP** instead of
`0.0.0.0/0` (remove the port 80 rule). Sign-in is still required.

## Security notes

- The backend can start, stop and create containers on this host. Keep 8000
  private and the admin password strong (12+ characters, enforced at startup).
- Login is rate-limited (5 failures per 5 minutes per client).
- Write requests are rejected unless they come from `https://<SENTINEL_SITE>`.
- AWS student accounts bill per running hour; stop the instance when idle.
