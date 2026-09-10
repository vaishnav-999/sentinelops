import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

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
      <PageSkeleton />
    </>
  );
}
