import { engine } from "@/lib/simulation/engine";
import { pauseLive, resetLive, resumeLive } from "@/lib/live/live-connection";
import { IS_LIVE } from "./mode";

/**
 * Console-level commands that are not part of the SentinelClient contract.
 * In simulation mode they drive the engine; in live mode they go to the
 * backend (reset) or only affect this browser (pause/resume).
 */
export const controls = {
  pause(): void {
    if (IS_LIVE) pauseLive();
    else engine.pause();
  },
  resume(): void {
    if (IS_LIVE) resumeLive();
    else engine.resume();
  },
  reset(): void {
    if (IS_LIVE) void resetLive();
    else engine.reset();
  },
};

/** "Reset Demo" in simulation, "Reset environment" against real containers. */
export const RESET_LABEL = IS_LIVE ? "Reset environment" : "Reset Demo";
