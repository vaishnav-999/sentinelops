"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { summarise } from "@/lib/incidents";

/**
 * The five figures at the top of /incidents, all derived from the store — no
 * hardcoded numbers. MTTD and MTTR are means over simulated runs and are
 * labelled as such; before any run has been recorded they read "—" rather than
 * inventing a value (AGENTS.md, academic honesty).
 */
export function IncidentsSummary() {
  const incidents = useSentinelStore((s) => s.incidents);
  const runs = useSentinelStore((s) => s.experimentRuns);
  const now = useSentinelStore((s) => s.cluster.t);

  const s = summarise(incidents, runs, now);

  return (
    <Panel>
      <div className="grid grid-cols-2 divide-y divide-border sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5">
        <Stat label="Active" value={s.active} tone={s.active > 0 ? "warn" : "text"} />
        <Stat label="Auto-healed today" value={s.autoHealedToday} tone="ok" />
        <Stat
          label="Needs attention"
          value={s.needsAttention}
          tone={s.needsAttention > 0 ? "crit" : "text"}
        />
        <Stat
          label="MTTD"
          value={s.mttdSec}
          unit="s"
          note={s.mttdSec === null ? "No runs yet" : `Simulated · ${s.mttdSamples} runs`}
        />
        <Stat
          label="MTTR"
          value={s.mttrSec}
          unit="s"
          note={
            s.mttrSec === null
              ? "No runs yet"
              : `Simulated · ${s.mttrSamples} incidents`
          }
        />
      </div>
    </Panel>
  );
}

function Stat({
  label,
  value,
  unit,
  note,
  tone = "text",
}: {
  label: string;
  value: number | null;
  unit?: string;
  note?: string;
  tone?: "text" | "ok" | "warn" | "crit";
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok-text"
      : tone === "warn"
        ? "text-warn-text"
        : tone === "crit"
          ? "text-crit-text"
          : "text-text";

  return (
    <div className="border-border px-4 py-3 lg:border-r lg:last:border-r-0">
      <div className="label">{label}</div>
      <div className={cn("mt-1 text-xl", numeric, toneClass)}>
        {value === null ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            {value}
            {unit ? <span className="text-base text-muted"> {unit}</span> : null}
          </>
        )}
      </div>
      {note ? (
        <div className="mt-1">
          <Badge variant="outline" className="font-normal">
            {note}
          </Badge>
        </div>
      ) : null}
    </div>
  );
}
