"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "dark"}
      className="toaster group"
      position="bottom-right"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-ok-text" strokeWidth={1.75} />
        ),
        info: (
          <InfoIcon className="size-4 text-brand-text" strokeWidth={1.75} />
        ),
        warning: (
          <TriangleAlertIcon
            className="size-4 text-warn-text"
            strokeWidth={1.75}
          />
        ),
        error: (
          <OctagonXIcon className="size-4 text-crit-text" strokeWidth={1.75} />
        ),
        loading: (
          <Loader2Icon
            className="size-4 animate-spin text-muted"
            strokeWidth={1.75}
          />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--panel)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--panel)",
          "--success-text": "var(--text)",
          "--success-border": "var(--border)",
          "--error-bg": "var(--panel)",
          "--error-text": "var(--text)",
          "--error-border": "var(--border)",
          "--border-radius": "8px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "border border-border bg-panel text-text shadow-lg text-sm",
          title: "text-text text-sm font-medium",
          description: "text-text-2 text-xs",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
