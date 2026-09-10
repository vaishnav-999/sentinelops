
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

## Design system (locked — overrides anything else)
- Type scale only 12/14/16/20/24/32px. Body 14. Labels 12px muted, sentence case. Weights 400/500;
  600 only for page titles. Metric values: Geist Mono, 500, tabular-nums.
- Spacing on a 4px grid only: panel padding 16, gap between panels 12, section gap 24.
- Radius: 6px controls, 8px panels. Pills only for status badges.
- Surfaces: page #07090D, panel #0D1117, raised #111722. 1px borders #1C2635.
  No shadows except popovers, dialogs, sheets.
- Color roles: cyan #31D7FF only for primary action, focus ring, LIVE indicator, selected chart series.
  Status colors (ok #39E58C, warn #FFC857, crit #FF5D73) only as text, dots, 2px rails, chart lines;
  badges = ~12% tint background + full-color text. Purple #9D7BFF only for ML/anomaly data.
- Text: #F5F7FA primary, #93A4B8 secondary, #66758A muted.
- Icons: lucide only, 16px, stroke 1.75, muted. Not every label gets an icon. No emojis.
- Motion: 150–200ms ease-out, no springs/bounce, only on state change. Continuous motion only for
  the LIVE dot and non-healthy status indicators. Respect prefers-reduced-motion.
- Charts: exact palette; muted small axes; horizontal gridlines only, low opacity; 1.5px strokes;
  no dots on lines; direct labels instead of legends.
- Forbidden: glow (except non-healthy status dots), blur (except top bar), gradients, gradient text,
  aurora/shader/animated backgrounds, animated or shimmering borders, spotlight hovers, 3D cards,
  cards inside cards, tinted icon squares on every card, marketing copy, suspiciously round numbers.
- Maximum one level of container; use dividers and section headers instead of nesting.
- Only two visually special elements: the Sentinel Status Island and the Chaos Lab run console.
- Density over whitespace. Must look like a shipped observability product, not a template.
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
