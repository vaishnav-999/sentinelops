"use client";

import { useTheme } from "next-themes";
import { Bell, Info, Menu, Monitor, Moon, Search, Sun } from "lucide-react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { ENVIRONMENTS, OPERATOR, TIME_RANGES } from "@/lib/mock-data/constants";
import { engine } from "@/lib/simulation/engine";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { EnvironmentId, Severity, TimeRange } from "@/lib/types";
import { useMounted } from "@/lib/hooks/use-mounted";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const IMPORTANT: Severity[] = ["warn", "crit", "ai", "ok"];

/** Browser-only; call after mount so the ⌘ hint never renders on the server. */
function isMac(): boolean {
  return (
    navigator.platform.toUpperCase().includes("MAC") ||
    navigator.userAgent.includes("Mac")
  );
}

const SEV_DOT: Record<Severity, string> = {
  info: "bg-muted",
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
  ai: "bg-ai",
};

function formatEventTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Account and theme"
      >
        <Avatar size="sm">
          <AvatarFallback>{OPERATOR.initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {/* Plain header, not a GroupLabel: base-ui group parts throw outside a
            Menu.Group / Menu.RadioGroup, which takes the whole menu down. */}
        <div className="px-1.5 py-1">
          <div className="text-sm text-text">{OPERATOR.name}</div>
          <div className="text-xs text-muted">{OPERATOR.role}</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={mounted ? (theme ?? "dark") : "dark"}
          onValueChange={(v) => {
            if (v) setTheme(v);
          }}
        >
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioItem value="dark" className="gap-2">
            <Moon className="size-4 text-muted" strokeWidth={1.75} />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light" className="gap-2">
            <Sun className="size-4 text-muted" strokeWidth={1.75} />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" className="gap-2">
            <Monitor className="size-4 text-muted" strokeWidth={1.75} />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar({ onOpenMobile }: { onOpenMobile: () => void }) {
  const live = useSentinelStore((s) => s.live);
  const environment = useSentinelStore((s) => s.environment);
  const setEnvironment = useSentinelStore((s) => s.setEnvironment);
  const timeRange = useSentinelStore((s) => s.timeRange);
  const setTimeRange = useSentinelStore((s) => s.setTimeRange);
  const servicesOnline = useSentinelStore((s) => s.cluster.servicesOnline);
  const events = useSentinelStore((s) => s.events);
  const setCommandOpen = useSentinelStore((s) => s.setCommandOpen);
  const reduced = useReducedMotion();

  const cluster =
    ENVIRONMENTS.find((e) => e.id === environment)?.cluster ??
    "sentinel-prod-cluster";

  // navigator is browser-only, so the hint renders as Ctrl K until mounted.
  const mounted = useMounted();
  const shortcut = mounted && isMac() ? "⌘K" : "Ctrl K";

  const important = events
    .filter((e) => IMPORTANT.includes(e.severity))
    .slice(-12)
    .reverse();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg pl-3 pr-4">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        aria-label="Open navigation"
        onClick={onOpenMobile}
      >
        <Menu className="size-4 text-muted" strokeWidth={1.75} />
      </Button>

      <Select
        value={environment}
        onValueChange={(v) => {
          if (v) setEnvironment(v as EnvironmentId);
        }}
      >
        <SelectTrigger className="hidden h-8 border-transparent bg-transparent text-sm shadow-none hover:bg-hover dark:bg-transparent dark:hover:bg-hover sm:flex">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          {ENVIRONMENTS.map((env) => (
            <SelectItem key={env.id} value={env.id} className="text-sm">
              {env.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <button
        type="button"
        onClick={() => (live ? engine.pause() : engine.resume())}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-2 hover:bg-hover outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        aria-pressed={live}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            live ? "bg-ok" : "bg-muted",
            live && !reduced && "animate-pulse",
          )}
        />
        <span className="text-text-2">
          {live ? "Live" : "Paused"}
        </span>
      </button>

      <span
        className={cn(
          "hidden text-xs text-text-2 min-[1280px]:inline",
          numeric,
        )}
      >
        {cluster}
      </span>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <div className="hidden items-center rounded-md border border-border lg:flex">
          {TIME_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setTimeRange(range)}
              aria-pressed={timeRange === range}
              className={cn(
                "h-7 px-2 text-xs",
                "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                timeRange === range
                  ? "bg-selected text-text"
                  : "text-muted hover:text-text",
              )}
            >
              {range}
            </button>
          ))}
        </div>

        <Select
          value={timeRange}
          onValueChange={(v) => {
            if (v) setTimeRange(v as TimeRange);
          }}
        >
          <SelectTrigger className="h-7 border-transparent bg-transparent text-xs shadow-none hover:bg-hover dark:bg-transparent dark:hover:bg-hover lg:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            {TIME_RANGES.map((range) => (
              <SelectItem key={range} value={range} className="text-sm">
                {range}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-text-2 hover:bg-hover outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-label="Open command palette"
        >
          <Search className="size-4 text-muted" strokeWidth={1.75} />
          <span className={cn("hidden sm:inline", numeric)}>{shortcut}</span>
        </button>

        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Notifications"
              />
            }
          >
            <Bell className="size-4 text-muted" strokeWidth={1.75} />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <PopoverHeader className="border-b border-border px-3 py-2">
              <PopoverTitle className="text-sm font-medium">
                Notifications
              </PopoverTitle>
            </PopoverHeader>
            {important.length === 0 ? (
              <p className="px-3 py-6 text-sm text-muted">
                No important events yet.
              </p>
            ) : (
              <ScrollArea className="max-h-72">
                <ul className="flex flex-col">
                  {important.map((event) => (
                    <li
                      key={event.id}
                      className="flex gap-2 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          SEV_DOT[event.severity],
                        )}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text">{event.message}</p>
                        <p className={cn("text-xs text-muted", numeric)}>
                          {formatEventTime(event.t)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </PopoverContent>
        </Popover>

        <ThemeMenu />

        <span className="hidden items-center gap-1 text-xs text-text-2 min-[1440px]:inline-flex">
          <AnimatedNumber value={servicesOnline} />
          <span>services online</span>
        </span>

        <span className="hidden items-center gap-1 text-xs text-muted min-[1280px]:inline-flex">
          <Info className="size-3.5 shrink-0" strokeWidth={1.75} />
          Demo · simulated data
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex items-center rounded-sm text-muted min-[1280px]:hidden outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                aria-label="Demo · simulated data"
              />
            }
          >
            <Info className="size-3.5" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent className="border border-border bg-panel text-text">
            Demo · simulated data
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
