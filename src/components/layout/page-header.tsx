"use client";

import type { ReactNode } from "react";
import { cn } from "cn";
import { StatusIsland } from "@/components/layout/status-island";

export function PageHeader({
  title,
  description,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex items-center justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold text-text">{title}</h1>
        {description ? (
          <p className="mt-1 truncate text-sm text-text-2">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">
        <StatusIsland />
      </div>
    </header>
  );
}
