import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

export const metadata: Metadata = {
  title: "Overview — SentinelOps",
};

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Live cluster health, telemetry and service status."
      />
      <PageSkeleton />
    </>
  );
}
