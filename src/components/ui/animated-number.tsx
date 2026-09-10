"use client";

import { useEffect, useRef, useState } from "react";
import { animate } from "motion/react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { MOTION } from "@/lib/motion";

/**
 * Ease-out number tween. No springs. Honors reduced motion.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  current.current = display;

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const controls = animate(current.current, value, {
      duration: MOTION.duration,
      ease: MOTION.ease,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, reduced]);

  return <span className={cn(numeric, className)}>{display.toFixed(decimals)}</span>;
}
