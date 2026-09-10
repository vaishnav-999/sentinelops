"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { engine } from "@/lib/simulation/engine";
import { sentinelStore } from "@/lib/store/sentinel-store";

/**
 * Boots the simulation engine exactly once on the client.
 *
 * The engine is a module-level singleton and `start()` is idempotent, so React
 * StrictMode's double-mount can't create a second timer. We intentionally do
 * NOT stop the engine on cleanup — it lives for the lifetime of the app so
 * telemetry keeps flowing across route changes, which is what lets a run
 * started on /chaos-lab carry on while you watch it on /overview.
 *
 * Toasts are pushed through a registered sink rather than imported inside the
 * engine, keeping the engine free of browser-only dependencies (the smoke
 * script runs the very same code under node).
 */
export function SimulationProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    engine.setNotifier((level, title, description) => {
      // Notification preferences from /settings are enforced here rather than
      // in the engine: the engine stays free of UI concerns, and the switches
      // on Settings genuinely change what the operator sees.
      const { notifyToasts, notifyCriticalOnly } = sentinelStore.get().settings;
      if (!notifyToasts) return;
      if (notifyCriticalOnly && level !== "error" && level !== "warning") return;
      toast[level](title, description ? { description } : undefined);
    });
    // Boot (or resume) the singleton so first paint is LIVE, not a stale pause.
    engine.start();
    return () => engine.setNotifier(null);
  }, []);

  return <>{children}</>;
}
