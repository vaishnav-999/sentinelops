import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

export const metadata: Metadata = {
  title: "Logs — SentinelOps",
};

export default function LogsPage() {
  return (
    <>
      <PageHeader
        title="Logs"
        description="Live application and detector log stream."
      />
      <PageSkeleton />
    </>
  );
}
