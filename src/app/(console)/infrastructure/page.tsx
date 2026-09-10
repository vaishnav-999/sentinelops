import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

export const metadata: Metadata = {
  title: "Infrastructure — SentinelOps",
};

export default function InfrastructurePage() {
  return (
    <>
      <PageHeader
        title="Infrastructure"
        description="Topology of services, containers and data stores."
      />
      <PageSkeleton />
    </>
  );
}
