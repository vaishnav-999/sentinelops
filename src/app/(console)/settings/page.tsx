import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

export const metadata: Metadata = {
  title: "Settings — SentinelOps",
};

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Monitoring, auto-heal, notifications and safety policies."
      />
      <PageSkeleton />
    </>
  );
}
