import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The single container level allowed by the design system: 8px radius, 1px
 * border, panel surface. Sections inside a panel are separated by dividers and
 * headers — never by another bordered box.
 */
export function Panel({
  className,
  children,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

/** 40px header row: 12px title on the left, meta/controls on the right. */
export function PanelHeader({
  title,
  actions,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-4",
        className,
      )}
    >
      <h2 className="truncate text-xs font-medium text-text-2">{title}</h2>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
