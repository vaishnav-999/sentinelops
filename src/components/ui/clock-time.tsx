"use client";

import { formatClockTime } from "@/lib/metrics";
import { useMounted } from "@/lib/hooks/use-mounted";

/**
 * A wall-clock timestamp, rendered only in the browser.
 *
 * `formatClockTime` reads the *local* hours/minutes/seconds of an absolute
 * epoch, so the same seeded timestamp formats differently on the build machine
 * and in a viewer's timezone. Anywhere seeded data can reach the server render
 * (e.g. the seeded execution transcript on /auto-heal) that is a hydration
 * mismatch, so the server emits a fixed-width dash placeholder instead and the
 * real time appears after mount — no layout shift, no mismatch.
 */
export function ClockTime({ t }: { t: number }) {
  const mounted = useMounted();
  return <>{mounted ? formatClockTime(t) : "--:--:--"}</>;
}
