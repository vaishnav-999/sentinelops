"use client";

import { useEffect, useState } from "react";
import { useSentinelStore } from "@/lib/store/sentinel-store";

/**
 * True when either the store flag or the OS prefers-reduced-motion is on.
 * Safe for SSR: starts false and syncs after mount (no hydration mismatch
 * as long as first paint does not depend on the media query).
 */
export function useReducedMotion(): boolean {
  const flag = useSentinelStore((s) => s.reducedMotion);
  const [prefers, setPrefers] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setPrefers(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return flag || prefers;
}
