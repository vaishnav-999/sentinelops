"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ClockTime } from "@/components/ui/clock-time";
import { tokenizeTerminal } from "@/lib/remediation";
import { TONE_TEXT } from "@/lib/tone";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type { TerminalLine } from "@/lib/types";

/** Typing speed for the live transcript, ms per character. */
const CHAR_MS = 10;

/** Treat "within a line height of the bottom" as pinned to the bottom. */
const BOTTOM_SLACK_PX = 24;

/** How far the transcript has been typed out, for one execution. */
interface Progress {
  executionId: string | null;
  /** Lines fully rendered; the next one is mid-typing. */
  shown: number;
  /** The partially typed text of line `shown`, or "" when not typing. */
  partial: string;
}

/**
 * The execution transcript.
 *
 * A live run types its lines in as they arrive — the one place in the product
 * where the delay is the point, because it is what an operator watching a
 * recovery actually sees. A finished execution renders instantly: replaying a
 * three-hour-old restart character by character would be theatre.
 *
 * Both the typing progress and the scroll pin are keyed on the execution id and
 * reconciled during render, so switching executions needs no reset effect and
 * no state is ever set synchronously from an effect body.
 *
 * Auto-scroll follows the tail only while the reader is already at the bottom;
 * scrolling up to read an earlier line parks the view and offers "Jump to
 * latest" instead of yanking it back.
 */
export function ExecutionTerminal({
  executionId,
  lines,
  live,
}: {
  executionId: string | null;
  lines: TerminalLine[];
  live: boolean;
}) {
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [progress, setProgress] = useState<Progress>({
    executionId,
    shown: lines.length,
    partial: "",
  });
  const [pin, setPin] = useState({ executionId, atBottom: true });

  // Selecting another execution starts from whatever that record already
  // holds, so only genuinely new lines are ever typed.
  const current: Progress =
    progress.executionId === executionId
      ? progress
      : { executionId, shown: lines.length, partial: "" };
  const pinned = pin.executionId === executionId ? pin.atBottom : true;

  const instant = !live || reduced;
  const shown = instant ? lines.length : Math.min(current.shown, lines.length);
  const partial = instant ? "" : current.partial;

  /** The line waiting to be typed, or null when the tail is caught up. */
  const pendingText = instant ? null : (lines[shown]?.text ?? null);

  useEffect(() => {
    if (pendingText === null) return;
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if (i >= pendingText.length) {
        clearInterval(timer);
        setProgress({ executionId, shown: shown + 1, partial: "" });
        return;
      }
      setProgress({ executionId, shown, partial: pendingText.slice(0, i) });
    }, CHAR_MS);
    return () => clearInterval(timer);
  }, [pendingText, executionId, shown]);

  // A line landing while the reader sits at the bottom should stay in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [shown, partial, pinned, executionId]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    setPin({ executionId, atBottom });
  }, [executionId]);

  const jump = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPin({ executionId, atBottom: true });
  }, [executionId]);

  const visible = lines.slice(0, shown);
  const typingLine = partial === "" ? null : lines[shown];

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-3"
      >
        {lines.length === 0 ? (
          <p className="text-sm text-muted">
            {live
              ? "Waiting for the first line…"
              : "This execution recorded no output."}
          </p>
        ) : (
          <ol className={cn("space-y-0.5 text-[13px] leading-5", numeric)}>
            {visible.map((line) => (
              <Line key={line.id} line={line} />
            ))}
            {typingLine ? (
              <Line
                key={`${typingLine.id}-typing`}
                line={{ ...typingLine, text: partial }}
                caret
              />
            ) : null}
          </ol>
        )}
      </div>

      {pinned ? null : (
        <Button
          size="xs"
          variant="secondary"
          onClick={jump}
          className="absolute right-4 bottom-3 shadow-sm"
        >
          <ArrowDown strokeWidth={1.75} />
          Jump to latest
        </Button>
      )}
    </div>
  );
}

function Line({ line, caret }: { line: TerminalLine; caret?: boolean }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 text-muted">
        [<ClockTime t={line.t} />]
      </span>
      <span className="min-w-0 text-text-2">
        {tokenizeTerminal(line.text).map((token, i) => (
          <span key={i} className={token.tone ? TONE_TEXT[token.tone] : undefined}>
            {token.text}
          </span>
        ))}
        {caret ? <span className="text-brand-text">▌</span> : null}
      </span>
    </li>
  );
}
