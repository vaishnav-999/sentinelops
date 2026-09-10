"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, motion } from "motion/react";
import {
  BookOpen,
  Brain,
  ChevronsLeft,
  FlaskConical,
  HeartPulse,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { NAV_ITEMS, type NavIconId } from "@/lib/nav";
import { MOTION } from "@/lib/motion";
import { OPERATOR } from "@/lib/mock-data/constants";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import type { ConnectionStatus, IslandState, ServiceStatus } from "@/lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SentinelMark } from "@/components/layout/mark";

const ICONS: Record<NavIconId, LucideIcon> = {
  overview: LayoutDashboard,
  infrastructure: Server,
  incidents: TriangleAlert,
  "auto-heal": HeartPulse,
  "chaos-lab": FlaskConical,
  logs: ScrollText,
  "ml-insights": Brain,
  settings: Settings,
};

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SLOT = "relative z-10 flex size-4 shrink-0 items-center justify-center";
const ROW =
  "relative flex h-9 items-center rounded-md px-2 text-sm transition-colors duration-150";

function clusterTone(
  connection: ConnectionStatus,
  island: IslandState,
  statuses: ServiceStatus[],
): "ok" | "warn" | "crit" {
  if (connection === "lost") return "crit";
  if (island === "escalated") return "crit";
  if (island === "anomaly") return "warn";
  if (island === "healing" || island === "verifying" || island === "diagnosing") {
    return "warn";
  }
  if (statuses.some((s) => s === "critical")) return "crit";
  if (statuses.some((s) => s === "degraded" || s === "recovering")) return "warn";
  return "ok";
}

const TONE_DOT: Record<"ok" | "warn" | "crit", string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
};

function RailTip({
  label,
  enabled,
  children,
}: {
  label: string;
  enabled: boolean;
  children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger
        className="w-full"
        render={<div className="w-full" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        className="border border-border bg-panel text-text"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  collapsed,
  onNavigate,
  layoutId,
  showCollapse = true,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  layoutId: string;
  showCollapse?: boolean;
}) {
  const pathname = usePathname();
  const toggleSidebar = useSentinelStore((s) => s.toggleSidebar);
  const connection = useSentinelStore((s) => s.connection);
  const island = useSentinelStore((s) => s.islandState);
  const worstStatus = useSentinelStore((s) => {
    if (s.services.some((svc) => svc.status === "critical")) return "critical";
    if (s.services.some((svc) => svc.status === "degraded")) return "degraded";
    if (s.services.some((svc) => svc.status === "recovering")) return "recovering";
    return "healthy";
  });
  const tone = clusterTone(connection, island, [worstStatus]);

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-12 shrink-0 items-center border-b border-border px-3",
          collapsed ? "justify-center" : "justify-between gap-2",
        )}
      >
        <Link
          href="/overview"
          onClick={onNavigate}
          className={cn(
            "flex min-w-0 items-center gap-2 text-text",
            collapsed && "justify-center",
          )}
        >
          <SentinelMark className="text-text" />
          {!collapsed ? (
            <span className="truncate text-sm font-medium">SentinelOps</span>
          ) : null}
        </Link>
        {showCollapse && !collapsed ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Collapse sidebar"
            onClick={toggleSidebar}
          >
            <ChevronsLeft {...ICON} className="text-muted" />
          </Button>
        ) : null}
      </div>

      {showCollapse && collapsed ? (
        <div className="flex justify-center py-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Expand sidebar"
                  onClick={toggleSidebar}
                />
              }
            >
              <ChevronsLeft {...ICON} className="text-muted rotate-180" />
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="border border-border bg-panel text-text"
            >
              Expand sidebar
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      <LayoutGroup id={layoutId}>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map((item) => {
            const Icon = ICONS[item.icon];
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            const row = (
              <Link
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  ROW,
                  collapsed ? "justify-center" : "gap-2",
                  active ? "text-text" : "text-text-2 hover:text-text",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-md bg-selected"
                    transition={MOTION}
                  />
                ) : null}
                <span className={SLOT}>
                  <Icon
                    {...ICON}
                    className={active ? "text-text" : "text-muted"}
                  />
                </span>
                {!collapsed ? (
                  <span className="relative z-10 truncate">{item.label}</span>
                ) : null}
              </Link>
            );
            return (
              <RailTip key={item.href} label={item.label} enabled={collapsed}>
                {row}
              </RailTip>
            );
          })}
        </nav>
      </LayoutGroup>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-border px-2 py-3">
        <RailTip label="Documentation" enabled={collapsed}>
          <div
            className={cn(
              ROW,
              "text-text-2",
              collapsed ? "justify-center" : "gap-2",
            )}
          >
            <span className={SLOT}>
              <BookOpen {...ICON} className="text-muted" />
            </span>
            {!collapsed ? <span className="truncate">Documentation</span> : null}
          </div>
        </RailTip>

        <RailTip label="System Status" enabled={collapsed}>
          <div
            className={cn(
              ROW,
              "text-text-2",
              collapsed ? "justify-center" : "gap-2",
            )}
          >
            <span className={SLOT}>
              <span
                className={cn("size-2 rounded-full", TONE_DOT[tone])}
                aria-hidden
              />
            </span>
            {!collapsed ? <span className="truncate">System Status</span> : null}
          </div>
        </RailTip>

        <RailTip
          label={`${OPERATOR.name} · ${OPERATOR.role}`}
          enabled={collapsed}
        >
          <div
            className={cn(ROW, collapsed ? "justify-center" : "gap-2")}
          >
            <span className={SLOT}>
              <Avatar className="size-4 after:hidden">
                <AvatarFallback className="text-xs">
                  {OPERATOR.initials}
                </AvatarFallback>
              </Avatar>
            </span>
            {!collapsed ? (
              <div className="min-w-0 leading-tight">
                <div className="truncate text-sm text-text">{OPERATOR.name}</div>
                <div className="truncate text-xs text-muted">{OPERATOR.role}</div>
              </div>
            ) : null}
          </div>
        </RailTip>
      </div>
    </div>
  );
}
