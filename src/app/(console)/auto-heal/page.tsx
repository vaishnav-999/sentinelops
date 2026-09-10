import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

export const metadata: Metadata = {
  title: "Auto-Heal — SentinelOps",
};

export default function AutoHealPage() {
  return (
    <>
      <PageHeader
        title="Auto-Heal"
        description="Safe remediation policies for known operational failures."
      />
      <PageSkeleton />
    </>
  );
}
