"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IS_LIVE } from "@/lib/api/mode";
import {
  isReportable,
  type IncidentReportResponse,
} from "@/lib/ai/incident-report";
import type { Incident } from "@/lib/types";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; data: IncidentReportResponse }
  | { kind: "error"; message: string };

const SOURCE_NOTE = IS_LIVE
  ? "AI-generated narrative from demo-environment telemetry"
  : "AI-generated narrative from simulated telemetry";

/**
 * Post-incident narrative (SPEC 37). Generated on request from the recorded
 * incident; the model only writes prose, it never changes what was decided.
 * Mount with key={incident.id} so a different incident starts fresh.
 */
export function AiIncidentReport({ incident }: { incident: Incident }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const ready = isReportable(incident);

  async function generate() {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/ai/incident-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incident }),
      });
      const body = (await res.json().catch(() => null)) as
        | (IncidentReportResponse & { detail?: string })
        | null;
      if (!res.ok || !body?.report) {
        setState({ kind: "error", message: body?.detail ?? `Request failed (${res.status})` });
        return;
      }
      setState({ kind: "done", data: body });
    } catch {
      setState({ kind: "error", message: "Could not reach the report service" });
    }
  }

  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="label">Post-incident report</h3>
        {state.kind === "done" ? (
          <Button variant="ghost" size="sm" onClick={generate}>
            Regenerate
          </Button>
        ) : null}
      </div>

      {!ready ? (
        <p className="text-sm text-muted">
          Available once the incident is resolved or escalated.
        </p>
      ) : state.kind === "idle" || state.kind === "loading" ? (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={generate}
            disabled={state.kind === "loading"}
          >
            {state.kind === "loading" ? "Writing report…" : "Generate report"}
          </Button>
          <span className="text-xs text-muted">
            Narrative only — remediation was decided by policy.
          </span>
        </div>
      ) : state.kind === "error" ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-crit-text">{state.message}</span>
          <Button variant="outline" size="sm" onClick={generate}>
            Retry
          </Button>
        </div>
      ) : (
        <ReportBody data={state.data} />
      )}
    </section>
  );
}

function ReportBody({ data }: { data: IncidentReportResponse }) {
  const { report } = data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {data.source === "gemini" ? (
          <>
            <Badge variant="ai">Gemini</Badge>
            <span className="text-xs text-muted">
              {SOURCE_NOTE} · {data.model}
            </span>
          </>
        ) : (
          <>
            <Badge variant="outline">Deterministic</Badge>
            <span className="text-xs text-muted">
              Built from recorded incident data · {data.reason ?? "Gemini unavailable"}
            </span>
          </>
        )}
      </div>
      <dl className="flex flex-col gap-3">
        <Item label="Summary" text={report.summary} />
        <Item label="Impact" text={report.impact} />
        <Item label="Root cause" text={report.rootCause} />
        <Item label="Resolution" text={report.resolution} />
        <div>
          <dt className="label">Follow-ups</dt>
          <dd className="mt-1">
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-text">
              {report.followUps.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Item({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-1 text-sm text-text">{text}</dd>
    </div>
  );
}
