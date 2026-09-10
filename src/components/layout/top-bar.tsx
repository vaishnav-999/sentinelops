"use client";

import { useEffect, useState } from "react";
import { Bell, Menu, Search } from "lucide-react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { ENVIRONMENTS, OPERATOR, TIME_RANGES } from "@/lib/mock-data/constants";
import { engine } from "@/lib/simulation/engine";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { EnvironmentId, Severity, TimeRange } from "@/lib/types";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export function TopBar({ onOpenMobile }: { onOpenMobile: () => void }) {
  const live = useSentinelStore((s) => s.live);
  const environment = useSentinelStore((s) => s.environment);
  const setEnvironment = useSentinelStore((s) => s.setEnvironment);
  const timeRange = useSentinelStore((s) => s.timeRange);
  const setTimeRange = useSentinelStore((s) => s.setTimeRange);
  const servicesOnline = useSentinelStore((s) => s.cluster.servicesOnline);
  const events = useSentinelStore((s) => s.events);
  const reduced = useReducedMotion();

  const cluster =
    ENVIRONMENTS.find((e) => e.id === environment)?.cluster ??
    "sentinel-prod-cluster";

  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => {
    const mac =
      navigator.platform.toUpperCase().includes("MAC") ||
      navigator.userAgent.includes("Mac");
    setShortcut(mac ? "⌘K" : "Ctrl K");
  }, []);

  const important = events
    .filter((e) => IMPORTANT.includes(e.severity))
    .slice(-12)
    .reverse();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg/80 pl-3 pr-4 backdrop-blur-md">
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
        <SelectTrigger className="hidden h-8 text-sm sm:flex">
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
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-2 hover:bg-elevated"
        aria-pressed={live}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            live ? "bg-brand" : "bg-muted",
            live && !reduced && "animate-pulse",
          )}
        />
        <span className={cn("font-medium", live ? "text-brand" : "text-muted")}>
          {live ? "LIVE" : "PAUSED"}
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
                timeRange === range
                  ? "bg-elevated text-text"
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
          <SelectTrigger className="h-7 text-xs lg:hidden">
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
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-text-2 hover:bg-elevated"
          aria-label="Search"
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

        <Avatar size="sm" className="hidden sm:flex">
          <AvatarFallback>{OPERATOR.initials}</AvatarFallback>
        </Avatar>

        <span className="hidden items-center gap-1 text-xs text-text-2 min-[1440px]:inline-flex">
          <AnimatedNumber value={servicesOnline} />
          <span>services online</span>
        </span>

        <Badge
          variant="outline"
          className="hidden h-6 rounded-full border-border text-xs text-text-2 min-[1280px]:inline-flex"
        >
          Demo Mode · Simulated data
        </Badge>
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                className="inline-flex h-6 rounded-full border-border text-xs text-text-2 min-[1280px]:hidden"
              />
            }
          >
            Demo
          </TooltipTrigger>
          <TooltipContent className="border border-border bg-elevated text-text">
            Demo Mode · Simulated data
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
