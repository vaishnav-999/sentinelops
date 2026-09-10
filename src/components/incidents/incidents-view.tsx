"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IncidentsSummary } from "@/components/incidents/incidents-summary";
import { IncidentsTable } from "@/components/incidents/incidents-table";
import { IncidentDetailSheet } from "@/components/incidents/incident-detail-sheet";
import { EMPTY_FILTERS, type IncidentFilters } from "@/lib/incidents";

/**
 * Owns the two pieces of page state: the filter set and which incident is open.
 *
 * The open incident lives in the URL (`/incidents?id=INC-1042`) so the Chaos
 * Lab "View incident" link lands straight on the detail sheet, and so a shared
 * link reopens the same incident.
 */
export function IncidentsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlId = params.get("id");

  const [filters, setFilters] = useState<IncidentFilters>(EMPTY_FILTERS);

  // The URL is the single source of truth for which incident is open, so
  // back/forward and inbound links need no extra bookkeeping.
  const selectedId = urlId;

  const select = useCallback(
    (id: string | null) => {
      router.replace(id ? `${pathname}?id=${id}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  return (
    <div className="flex flex-col gap-3">
      <IncidentsSummary />
      <IncidentsTable
        filters={filters}
        onFiltersChange={setFilters}
        selectedId={selectedId}
        onSelect={select}
      />
      <IncidentDetailSheet
        incidentId={selectedId}
        onClose={() => select(null)}
      />
    </div>
  );
}
