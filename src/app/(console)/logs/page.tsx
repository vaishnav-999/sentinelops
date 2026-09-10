import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { LogsView } from "@/components/logs/logs-view";

export const metadata: Metadata = {
  title: "Logs — SentinelOps",
};

export default function LogsPage() {
  return (
    <>
      <PageHeader
        title="Live Logs"
        description="Application, detector and auto-heal log stream."
      />
      <LogsView />
    </>
  );
}
