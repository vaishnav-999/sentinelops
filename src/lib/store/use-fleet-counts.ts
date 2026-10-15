"use client";

import { useShallow } from "zustand/react/shallow";
import { COUNTS } from "@/lib/mock-data/constants";
import { IS_LIVE } from "@/lib/api/mode";
import { useSentinelStore } from "./sentinel-store";

export interface FleetCounts {
  services: number;
  containers: number;
  databases: number;
  caches: number;
}

/**
 * Fleet counts: the fixed demo figures in simulation mode, counted from what
 * the backend actually discovered in live mode.
 */
export function useFleetCounts(): FleetCounts {
  return useSentinelStore(
    useShallow((s) =>
      IS_LIVE
        ? {
            services: s.services.length,
            containers: s.containers.length,
            databases: s.infraNodes.filter((n) => n.kind === "database").length,
            caches: s.infraNodes.filter((n) => n.kind === "cache").length,
          }
        : COUNTS,
    ),
  );
}
