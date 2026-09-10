import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { IncidentsView } from "@/components/incidents/incidents-view";

export const metadata: Metadata = {
  title: "Incidents — SentinelOps",
};

export default function IncidentsPage() {
  return (
    <>
      <PageHeader
        title="Incidents"
        description="Detected faults, diagnosis and recovery history."
      />
      {/* useSearchParams needs a boundary; the view is client-only anyway. */}
      <Suspense fallback={null}>
        <IncidentsView />
      </Suspense>
    </>
  );
}
