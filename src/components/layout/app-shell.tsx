"use client";

import { useEffect, useState, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { cn } from "cn";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { CommandPalette } from "@/components/layout/command-palette";
import { GlobalHotkeys } from "@/components/layout/hotkeys";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

export function AppShell({ children }: { children: ReactNode }) {
  const collapsed = useSentinelStore((s) => s.sidebarCollapsed);
  const reducedMotion = useSentinelStore((s) => s.reducedMotion);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Sheets, dialogs and toasts render in portals outside this tree, so the
  // in-app reduced-motion toggle is published on <html> where a CSS rule can
  // reach every one of them — the OS media query already covers the same set.
  useEffect(() => {
    const root = document.documentElement;
    if (reducedMotion) root.setAttribute("data-reduced-motion", "true");
    else root.removeAttribute("data-reduced-motion");
  }, [reducedMotion]);

  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
      <TooltipProvider delay={200}>
        <GlobalHotkeys />
        <CommandPalette />
        <div className="flex h-svh overflow-x-hidden bg-bg">
          <aside
            className={cn(
              "hidden shrink-0 overflow-hidden border-r border-border bg-bg md:block",
              !reducedMotion &&
                "transition-[width] duration-200 ease-out motion-reduce:transition-none",
            )}
            style={{ width: collapsed ? 72 : 220 }}
          >
            <Sidebar collapsed={collapsed} layoutId="nav-desk" />
          </aside>

          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[220px] border-border bg-bg p-0 sm:max-w-[220px]"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <Sidebar
                collapsed={false}
                layoutId="nav-mobile"
                showCollapse={false}
                onNavigate={() => setMobileOpen(false)}
              />
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar onOpenMobile={() => setMobileOpen(true)} />
            <main className="min-h-0 flex-1 overflow-auto">
              <div className="px-4 pb-4 pt-3">{children}</div>
            </main>
          </div>
        </div>
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  );
}
