"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Activity,
  AlertTriangle,
  Beaker,
  Brain,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Moon,
  Network,
  PanelLeft,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Settings as SettingsIcon,
  Wand2,
  Waves,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { engine } from "@/lib/simulation/engine";
import { api } from "@/lib/api";
import { NAV_ITEMS, type NavIconId } from "@/lib/nav";

/**
 * Global command palette (SPEC §16). Opened by Ctrl/⌘ K or the top-bar search
 * button; `commandOpen` lives in the store so both triggers, and any future
 * one, drive the same piece of state.
 *
 * Every command runs a real action — navigation, the engine, or a store
 * toggle. cmdk provides arrow-key navigation, type-ahead filtering and Esc.
 */

const NAV_ICON: Record<NavIconId, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  infrastructure: Network,
  incidents: AlertTriangle,
  "auto-heal": Wand2,
  "chaos-lab": FlaskConical,
  logs: ScrollText,
  "ml-insights": Brain,
  settings: SettingsIcon,
};

export function CommandPalette() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const open = useSentinelStore((s) => s.commandOpen);
  const setOpen = useSentinelStore((s) => s.setCommandOpen);
  const live = useSentinelStore((s) => s.live);
  const toggleSidebar = useSentinelStore((s) => s.toggleSidebar);
  const toggleReducedMotion = useSentinelStore((s) => s.toggleReducedMotion);
  const reducedMotion = useSentinelStore((s) => s.reducedMotion);

  /** Run a command and close: the palette never lingers over its own effect. */
  const run = useCallback(
    (action: () => void) => {
      setOpen(false);
      action();
    },
    [setOpen],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Navigate, control monitoring, run a demo scenario."
      className="sm:max-w-lg"
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = NAV_ICON[item.icon];
            return (
              <CommandItem
                key={item.href}
                value={`Go to ${item.label}`}
                onSelect={() => run(() => router.push(item.href))}
              >
                <Icon className="text-muted" strokeWidth={1.75} />
                Go to {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Monitoring">
          <CommandItem
            value="Pause monitoring"
            disabled={!live}
            onSelect={() => run(() => engine.pause())}
          >
            <Pause className="text-muted" strokeWidth={1.75} />
            Pause monitoring
          </CommandItem>
          <CommandItem
            value="Resume monitoring"
            disabled={live}
            onSelect={() => run(() => engine.resume())}
          >
            <Play className="text-muted" strokeWidth={1.75} />
            Resume monitoring
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Demo">
          <CommandItem
            value="Inject memory leak"
            onSelect={() =>
              run(() => {
                void api.injectChaos({ scenario: "memory-leak" });
                router.push("/chaos-lab");
              })
            }
          >
            <Beaker className="text-muted" strokeWidth={1.75} />
            Inject memory leak
          </CommandItem>
          <CommandItem
            value="Inject unknown anomaly"
            onSelect={() =>
              run(() => {
                void api.injectChaos({ scenario: "unknown-anomaly" });
                router.push("/chaos-lab");
              })
            }
          >
            <Activity className="text-muted" strokeWidth={1.75} />
            Inject unknown anomaly
          </CommandItem>
          <CommandItem
            value="Reset demo"
            onSelect={() => run(() => engine.reset())}
          >
            <RotateCcw className="text-muted" strokeWidth={1.75} />
            Reset demo
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Preferences">
          <CommandItem
            value="Toggle sidebar"
            onSelect={() => run(toggleSidebar)}
          >
            <PanelLeft className="text-muted" strokeWidth={1.75} />
            Toggle sidebar
          </CommandItem>
          <CommandItem
            value="Toggle theme"
            onSelect={() =>
              run(() => setTheme(theme === "light" ? "dark" : "light"))
            }
          >
            <Moon className="text-muted" strokeWidth={1.75} />
            Toggle theme
          </CommandItem>
          <CommandItem
            value="Toggle reduced motion"
            onSelect={() => run(toggleReducedMotion)}
          >
            {reducedMotion ? (
              <Gauge className="text-muted" strokeWidth={1.75} />
            ) : (
              <Waves className="text-muted" strokeWidth={1.75} />
            )}
            Toggle reduced motion
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
