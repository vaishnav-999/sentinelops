"use client";

import { PageHeader } from "@/components/layout/page-header";
import { useMounted } from "@/lib/hooks/use-mounted";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import {
  greetingFor,
  headlineSentence,
  monitoringSubtitle,
} from "@/lib/store/selectors";

/**
 * "Good evening. Production is healthy." — the greeting half needs the viewer's
 * local clock, so it only appears once mounted; the status half is store-driven
 * and therefore safe to render on the server (SPEC §8).
 */
export function OverviewHeader() {
  const island = useSentinelStore((s) => s.islandState);
  const mounted = useMounted();

  return (
    <PageHeader
      title={
        <>
          {mounted ? (
            <span className="text-text-2">
              {greetingFor(new Date().getHours())}{" "}
            </span>
          ) : null}
          {headlineSentence(island)}
        </>
      }
      description={monitoringSubtitle()}
    />
  );
}
