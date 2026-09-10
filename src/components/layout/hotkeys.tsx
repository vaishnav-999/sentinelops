"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import { engine } from "@/lib/simulation/engine";
import { useSentinelStore } from "@/lib/store/sentinel-store";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest("[contenteditable='true']")) return true;
  if (target.closest("[role='textbox']")) return true;
  return false;
}

/**
 * Ctrl/⌘ K opens the command palette; Shift+D injects the memory-leak
 * scenario; Shift+R resets the demo.
 */
export function GlobalHotkeys() {
  const toggleCommandOpen = useSentinelStore((s) => s.toggleCommandOpen);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // The palette is reachable from anywhere, including a focused input —
      // that is the whole point of a command palette.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandOpen();
        return;
      }
      if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "d") {
        event.preventDefault();
        void api.injectChaos({ scenario: "memory-leak" });
      } else if (key === "r") {
        event.preventDefault();
        engine.reset();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCommandOpen]);

  return null;
}
