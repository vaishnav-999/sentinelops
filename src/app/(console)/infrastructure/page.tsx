import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { InfrastructureView } from "@/components/infrastructure/infrastructure-view";

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
      <InfrastructureView />
    </>
  );
}
