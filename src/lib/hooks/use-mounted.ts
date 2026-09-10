"use client";

import { useSyncExternalStore } from "react";

/** No client store to watch — the value never changes after hydration. */
const subscribe = () => () => {};

/**
 * False during server render and the hydrating pass, true afterwards.
 *
 * Use this to gate anything that can only be known in the browser (the local
 * clock, `navigator`, the resolved theme). `useSyncExternalStore` gives React a
 * distinct server snapshot, so there is no hydration mismatch and — unlike a
 * `useState` + `useEffect` pair — no setState inside an effect body.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
