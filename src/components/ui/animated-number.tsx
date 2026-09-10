"use client";

import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { MOTION } from "@/lib/motion";

/**
 * Adapted from the 21st.dev "Number Ticker" (danielpetho/basic-number-ticker),
 * restyled onto our tokens: mono + tabular figures, a 180ms ease-out tween
 * instead of a spring, and an instant jump under reduced motion.
 *
 * The tween drives a MotionValue rather than React state, so a metric updating
 * every second does not re-render its subtree 60 times a second.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  format,
  className,
}: {
  value: number;
  decimals?: number;
  /** Overrides plain `toFixed`, e.g. compact "12.0K" throughput. */
  format?: (value: number) => string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const count = useMotionValue(value);
  const text = useTransform(count, (latest) =>
    format ? format(latest) : latest.toFixed(decimals),
  );

  useEffect(() => {
    if (reduced) {
      count.set(value);
      return;
    }
    const controls = animate(count, value, {
      duration: MOTION.duration,
      ease: MOTION.ease,
    });
    return () => controls.stop();
  }, [count, value, reduced]);

  return <motion.span className={cn(numeric, className)}>{text}</motion.span>;
}
