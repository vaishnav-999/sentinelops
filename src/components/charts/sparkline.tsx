import { cn } from "cn";

/**
 * A 32px inline trend line: 1.5px stroke, very light fill, no axes, no dots and
 * no animation, so six of them can update once a second without a repaint
 * storm. Recharts is reserved for the one large telemetry chart.
 */

export type SparkTone = "brand" | "ok" | "warn" | "crit" | "ai" | "muted";

const TONE_VAR: Record<SparkTone, string> = {
  brand: "var(--brand)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  crit: "var(--crit)",
  ai: "var(--ai)",
  muted: "var(--muted)",
};

/** Horizontal viewBox units; the SVG stretches to its container width. */
const VIEW_W = 100;
/** Vertical breathing room so peaks are not clipped by the stroke. */
const PAD = 2;

export function Sparkline({
  values,
  tone = "brand",
  height = 32,
  className,
}: {
  values: number[];
  tone?: SparkTone;
  height?: number;
  className?: string;
}) {
  const color = TONE_VAR[tone];

  if (values.length < 2) {
    return <div className={className} style={{ height }} aria-hidden />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;
  const usable = height - PAD * 2;

  const x = (i: number) => (i / (values.length - 1)) * VIEW_W;
  const y = (v: number) =>
    flat ? height / 2 : height - PAD - ((v - min) / (max - min)) * usable;

  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`)
    .join(" ");
  const area = `${line} L${VIEW_W} ${height} L0 ${height} Z`;

  return (
    <svg
      className={cn("w-full", className)}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      shapeRendering="geometricPrecision"
      aria-hidden
    >
      <path d={area} fill={color} fillOpacity={0.08} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
