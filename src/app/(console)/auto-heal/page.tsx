import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AutoHealView } from "@/components/remediation/auto-heal-view";

export const metadata: Metadata = {
  title: "Auto-Heal — SentinelOps",
};

export default function AutoHealPage() {
  return (
    <>
      <PageHeader
        title="Autonomous Recovery Engine"
        description="Safe remediation policies for known operational failures."
      />
      <AutoHealView />
    </>
  );
}
