import type { ModelStatus } from "@/lib/types";

/** One-line model state for Settings and ML Insights. */
export function modelStatusLabel(model: ModelStatus | null): string {
  if (!model) return "Simulated — training pending";
  if (model.status === "active") {
    return `Trained · ${model.trainedServices} of ${model.totalServices} services`;
  }
  const samples = Math.min(model.samples, model.warmupSamples);
  return `Learning baseline · ${samples}/${model.warmupSamples} samples`;
}
