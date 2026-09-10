import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PageSkeleton } from "@/components/layout/page-skeleton";

export const metadata: Metadata = {
  title: "Chaos Lab — SentinelOps",
};

export default function ChaosLabPage() {
  return (
    <>
      <PageHeader
        title="Chaos Lab"
        description="Safely inject controlled failures into the demo environment."
      />
      <PageSkeleton />
    </>
  );
}
