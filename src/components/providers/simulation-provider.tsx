"use client";

import { useEffect } from "react";
import { engine } from "@/lib/simulation/engine";

/**
 * Boots the simulation engine exactly once on the client.
 *
 * The engine is a module-level singleton and `start()` is idempotent, so React
 * StrictMode's double-mount can't create a second timer. We intentionally do
 * NOT stop the engine on cleanup — it lives for the lifetime of the app so
 * telemetry keeps flowing across route changes.
 */
export function SimulationProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Boot (or resume) the singleton so first paint is LIVE, not a stale pause.
    engine.start();
  }, []);

  return <>{children}</>;
}
