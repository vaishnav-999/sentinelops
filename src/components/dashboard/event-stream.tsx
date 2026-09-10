"use client";

import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { formatClockTime } from "@/lib/metrics";
import { SEVERITY_TONE, TONE_DOT, TONE_TEXT } from "@/lib/tone";

/** Enough rows to fill the column beside the telemetry chart without scrolling. */
const VISIBLE = 40;

/**
 * Live event stream (SPEC §8): a vertical timeline, newest first, with a rail
 * connecting the dots. Timestamps come from the engine clock and are formatted
 * explicitly — never via locale APIs, which would drift between server and
 * client.
 */
export function EventStream() {
  const events = useSentinelStore((s) => s.events);
  const live = useSentinelStore((s) => s.live);
  const reduced = useReducedMotion();

  const recent = events.slice(-VISIBLE).reverse();

  return (
    <Panel className="min-h-0">
      <PanelHeader
        title="Live activity"
        actions={
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                live ? "bg-ok" : "bg-muted",
                live && !reduced && "animate-pulse",
              )}
            />
            <span className="label">{live ? "Live" : "Paused"}</span>
          </span>
        }
      />

      {recent.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-10 text-xs text-muted">
          Waiting for the first events…
        </div>
      ) : (
        <ol className="flex-1 overflow-y-auto p-4">
          {recent.map((event, i) => {
            const tone = SEVERITY_TONE[event.severity];
            const last = i === recent.length - 1;

            return (
              <li key={event.id} className="relative flex gap-3 pb-3 last:pb-0">
                {/* Rail: stops at the last row so the timeline does not dangle. */}
                {last ? null : (
                  <span
                    className="absolute left-[3px] top-3 bottom-0 w-px bg-border"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    "relative mt-1.5 size-1.5 shrink-0 rounded-full",
                    TONE_DOT[tone],
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-2">{event.message}</p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className={cn("text-xs text-muted", numeric)}>
                      {formatClockTime(event.t)}
                    </span>
                    {event.serviceId ? (
                      <span className={cn("truncate text-xs text-muted", numeric)}>
                        {event.serviceId}
                      </span>
                    ) : null}
                    {event.severity !== "info" && event.severity !== "ok" ? (
                      <span className={cn("text-xs font-medium", TONE_TEXT[tone])}>
                        {event.kind}
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
