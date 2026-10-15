"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { engine } from "@/lib/simulation/engine";
import { sentinelStore } from "@/lib/store/sentinel-store";
import { IS_LIVE } from "@/lib/api/mode";
import { setLiveNotifier, startLive } from "@/lib/live/live-connection";

type ToastLevel = "success" | "info" | "warning" | "error";

/**
 * Notification preferences from /settings are enforced here rather than in the
 * engine or the backend: both stay free of UI concerns, and the switches on
 * Settings genuinely change what the operator sees.
 */
function showToast(level: ToastLevel, title: string, description?: string): void {
  const { notifyToasts, notifyCriticalOnly } = sentinelStore.get().settings;
  if (!notifyToasts) return;
  if (notifyCriticalOnly && level !== "error" && level !== "warning") return;
  toast[level](title, description ? { description } : undefined);
}

/**
 * Boots the data source exactly once on the client.
 *
 * Simulation mode: the engine is a module-level singleton and `start()` is
 * idempotent, so React StrictMode's double-mount can't create a second timer.
 * It is intentionally never stopped on cleanup, so telemetry keeps flowing
 * across route changes.
 *
 * Live mode: the engine never starts; a single WebSocket to the FastAPI
 * backend fills the store instead (src/lib/live/live-connection.ts).
 */
export function SimulationProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (IS_LIVE) {
      startLive(showToast);
      return () => setLiveNotifier(null);
    }
    engine.setNotifier(showToast);
    // Boot (or resume) the singleton so first paint is LIVE, not a stale pause.
    engine.start();
    return () => engine.setNotifier(null);
  }, []);

  return <>{children}</>;
}
