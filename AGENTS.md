
   ---

   ## Next.js version notes (from create-next-app)

## What this is
Final-year major project: Autonomous Application Monitoring & Self-Healing Operations Platform.
Current phase: premium frontend demo driven by a simulation engine, with clean API contracts
for a future FastAPI + PostgreSQL + Docker backend.
Full spec: docs/SPEC.md — read only the sections a task names.

## Stack (do not change)
- Next.js App Router, TypeScript strict, src/ directory, alias @/*
- Tailwind CSS + shadcn/ui, lucide-react icons
- Motion: import { motion, AnimatePresence, MotionConfig } from "motion/react"
- Recharts is the ONLY chart library
- Zustand for global state
- @tanstack/react-virtual for long lists
- @google/genai on the server only
Do not add any dependency without asking me first and explaining why.

## Commands
- dev: npm run dev
- typecheck: npx tsc --noEmit
- lint: npm run lint
- build: npm run build
Definition of done for EVERY task: typecheck and build pass, no console errors, no hydration warnings.

## Folder map
src/app/(console)/<route>/page.tsx      pages
src/app/api/ai/*                        server routes (Gemini only)
src/components/layout|dashboard|metrics|charts|incidents|infrastructure|remediation|chaos|logs|ml|ui
src/lib/types          shared domain types
src/lib/mock-data      seed data
src/lib/simulation     engine, noise, health score, scenarios
src/lib/store          zustand store
src/lib/api            SentinelClient interface + mock and http clients

## Architecture rules
- The simulation engine is the only owner of data timers. Components read from the store and call actions.
- Everything a chaos scenario changes flows through the store, so every page updates live without refresh.
- Scenarios are declarative step timelines: cancellable, re-runnable any number of times.
  Reset restores the exact seeded healthy state (including counters and ids).
- Engine is a module-level singleton; guard against React StrictMode double-mount.
- No Math.random(), Date.now() or locale date formatting during server render. Client-only init.
- No hardcoded metric numbers inside JSX; data comes from typed store/mock data.

## Design rules
Use tokens, never raw hex in components:
bg #07090D | bg-2 #0A0D12 | card #0D1117 | elevated #111722 | border #1C2635
text #F5F7FA | text-2 #93A4B8 | muted #66758A
brand/live cyan #31D7FF | ok #39E58C | warn #FFC857 | crit #FF5D73 | ai/anomaly #9D7BFF
- Color is semantic only. No gradient card backgrounds. Radius max 12px. No card-in-card-in-card.
- Geist Sans for UI. Geist Mono + tabular-nums for metrics, ids, timestamps, logs, scores.
- Data-dense product feel (Linear, Vercel, Datadog). Not an admin template. No emojis as icons.
- Animate on state change, not forever. Respect prefers-reduced-motion and the store reducedMotion flag.
- Desktop first: perfect at 1440x900 and 1920x1080. No horizontal overflow at 375px.

## Academic honesty (non-negotiable)
- Operational telemetry is simulated: show "Demo"/"Simulated" markers where relevant.
- Research metrics (precision, recall, F1, FPR, MTTD/MTTR improvement) display "—" + "Awaiting evaluation". Never invent them.
- Isolation Forest outputs an anomaly score only. Fault type comes from the Diagnoser. Use "Signature match".

## AI (Gemini) rules
- Key is GEMINI_API_KEY and model is GEMINI_MODEL in .env.local. Never read, print or edit .env files.
- Never use NEXT_PUBLIC_ for secrets. Gemini is called only from server route handlers.
- The LLM writes explanations/reports only. It never decides or executes remediation.
- Always implement a deterministic fallback.

## Working style
- Do NOT run git commit or git push. I commit after each phase.
- Before large changes, show a plan of at most 10 lines, then build.
- When done, report: files changed, exact browser verification steps, known gaps.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
