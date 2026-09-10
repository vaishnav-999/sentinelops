import { cn } from "cn";

/** Simple SentinelOps mark — hex plate with a scan arc. Current-color only. */
export function SentinelMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("size-5 shrink-0", className)}
    >
      <path
        d="M12 2.75 20.25 7.4v9.2L12 21.25 3.75 16.6V7.4L12 2.75Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <path
        d="M8.2 12a3.8 3.8 0 0 1 7.6 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
