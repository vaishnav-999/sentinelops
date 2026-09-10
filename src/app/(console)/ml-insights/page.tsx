import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MlInsightsView } from "@/components/ml/ml-insights-view";

export const metadata: Metadata = {
  title: "ML Insights — SentinelOps",
};

export default function MlInsightsPage() {
  return (
    <>
      <PageHeader
        title="ML Insights"
        description="Isolation Forest anomaly scores and research evaluation."
      />
      <MlInsightsView />
    </>
  );
}
