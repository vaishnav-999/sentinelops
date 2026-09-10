"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import { engine } from "@/lib/simulation/engine";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest("[contenteditable='true']")) return true;
  if (target.closest("[role='textbox']")) return true;
  return false;
}

/** Shift+D injects the memory-leak scenario; Shift+R resets the demo. */
export function GlobalHotkeys() {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
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
  }, []);

  return null;
}
