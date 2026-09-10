"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, Download, Pause, Play, Trash2 } from "lucide-react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { logSources } from "@/lib/simulation/log-stream";
import type { LogEntry, LogLevel } from "@/lib/types";

/**
 * /logs — the live log explorer.
 *
 * The engine owns the stream; this component only filters and renders it.
 * Pausing takes a snapshot of the current buffer and counts what has arrived
 * since, so "paused" genuinely means the list stops moving rather than the
 * platform stopping logging.
 *
 * The list is virtualised (@tanstack/react-virtual): 500 rows at ~3 lines a
 * second would otherwise re-render the whole DOM every tick.
 */

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

/** How many filtered lines the viewer keeps on screen. */
const VISIBLE_LIMIT = 500;

const ROW_HEIGHT = 22;

const LEVEL_CLASS: Record<LogLevel, string> = {
  DEBUG: "text-muted",
  INFO: "text-brand-text",
  WARN: "text-warn-text",
  ERROR: "text-crit-text",
};

const LEVEL_BADGE: Record<LogLevel, string> = {
  DEBUG: "bg-muted/15 text-muted",
  INFO: "bg-brand-badge text-brand-text",
  WARN: "bg-warn-badge text-warn-text",
  ERROR: "bg-crit-badge text-crit-text",
};

/** HH:MM:SS.mmm from an engine clock, without locale formatting. */
function formatLogTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** One rendered line, exactly as it is copied and downloaded. */
function formatLine(entry: LogEntry): string {
  return `${formatLogTime(entry.t)} ${entry.level.padEnd(5)} ${entry.service} ${entry.message}`;
}

export function LogsView() {
  const logs = useSentinelStore((s) => s.logs);
  const services = useSentinelStore((s) => s.services);

  const [service, setService] = useState<string>("all");
  const [levels, setLevels] = useState<LogLevel[]>([...LEVELS]);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  /** Frozen buffer while paused; null while streaming. */
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null);
  /** Lines cleared by the operator stay hidden until new ones arrive. */
  const [clearedBefore, setClearedBefore] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const paused = frozen !== null;
  const source = paused ? frozen : logs;

  const sources = useMemo(() => logSources(services), [services]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out: LogEntry[] = [];
    for (const entry of source) {
      if (clearedBefore !== null && entry.t <= clearedBefore) continue;
      if (service !== "all" && entry.service !== service) continue;
      if (!levels.includes(entry.level)) continue;
      if (
        q &&
        !entry.message.toLowerCase().includes(q) &&
        !entry.service.toLowerCase().includes(q)
      ) {
        continue;
      }
      out.push(entry);
    }
    return out.slice(-VISIBLE_LIMIT);
  }, [source, service, levels, search, clearedBefore]);

  /** New lines that arrived while paused, using the same filters. */
  const pendingCount = useMemo(() => {
    if (!paused) return 0;
    const lastT = frozen.length > 0 ? frozen[frozen.length - 1].t : 0;
    return logs.filter((l) => l.t > lastT).length;
  }, [paused, frozen, logs]);

  const scrollRef = useRef<HTMLDivElement>(null);

  // "Copied" reverts on a timer; keep the handle so unmounting cancels it.
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Follow the tail while streaming, unless the operator turned it off.
  useEffect(() => {
    if (!autoScroll || paused || filtered.length === 0) return;
    virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [autoScroll, paused, filtered.length, virtualizer]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setLevels((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level],
    );
  }, []);

  const visibleText = useCallback(
    () => filtered.map(formatLine).join("\n"),
    [filtered],
  );

  const onCopy = useCallback(async () => {
    if (filtered.length === 0) return;
    try {
      await navigator.clipboard.writeText(visibleText());
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied (insecure origin / permission); stay silent
      // rather than throwing an error toast the operator cannot act on.
      setCopied(false);
    }
  }, [filtered.length, visibleText]);

  const onDownload = useCallback(() => {
    if (filtered.length === 0) return;
    const blob = new Blob([`${visibleText()}\n`], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = formatLogTime(Date.now()).replace(/[:.]/g, "-");
    a.href = url;
    a.download = `sentinelops-${service === "all" ? "all" : service}-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [filtered.length, service, visibleText]);

  const onClear = useCallback(() => {
    const latest = logs.length > 0 ? logs[logs.length - 1].t : Date.now();
    setClearedBefore(latest);
    if (paused) setFrozen([]);
  }, [logs, paused]);

  const empty = filtered.length === 0;
  const anyLogs = logs.length > 0;

  return (
    <Panel className="min-h-[560px]">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Select
          value={service}
          onValueChange={(v) => {
            if (v) setService(v as string);
          }}
        >
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <SelectItem value="all" className="text-sm">
              All services
            </SelectItem>
            {sources.map((id) => (
              <SelectItem key={id} value={id} className="text-sm">
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center rounded-md border border-border">
          {LEVELS.map((level) => {
            const on = levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                aria-pressed={on}
                className={cn(
                  "h-8 px-2.5 text-xs outline-none",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  numeric,
                  on ? "bg-selected text-text" : "text-muted hover:text-text",
                )}
              >
                {level}
              </button>
            );
          })}
        </div>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages"
          aria-label="Search logs"
          className="h-8 w-56 text-sm"
        />

        <div className="ml-auto flex items-center gap-2">
          <Label
            htmlFor="auto-scroll"
            className="text-xs font-normal text-text-2 select-none"
          >
            Auto-scroll
          </Label>
          <Switch
            id="auto-scroll"
            checked={autoScroll}
            onCheckedChange={setAutoScroll}
          />
        </div>
      </div>

      {/* Stream controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Button
          variant={paused ? "default" : "outline"}
          size="sm"
          onClick={() => setFrozen(paused ? null : logs)}
        >
          {paused ? (
            <Play className="size-4" strokeWidth={1.75} />
          ) : (
            <Pause className="size-4" strokeWidth={1.75} />
          )}
          {paused ? "Resume stream" : "Pause stream"}
        </Button>
        <Button variant="outline" size="sm" onClick={onClear}>
          <Trash2 className="size-4" strokeWidth={1.75} />
          Clear
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onCopy}
          disabled={empty}
        >
          <Copy className="size-4" strokeWidth={1.75} />
          {copied ? "Copied" : "Copy visible"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDownload}
          disabled={empty}
        >
          <Download className="size-4" strokeWidth={1.75} />
          Download .log
        </Button>

        <span className={cn("ml-auto text-xs text-muted", numeric)}>
          {paused ? (
            <span className="text-warn-text">
              Paused · {pendingCount} new{" "}
              {pendingCount === 1 ? "line" : "lines"}
            </span>
          ) : (
            `${filtered.length} of ${logs.length} lines`
          )}
        </span>
      </div>

      {/* Stream */}
      {empty ? (
        <div className="flex flex-1 items-center justify-center px-4 py-16">
          <p className="text-sm text-muted">
            {anyLogs ? "No logs match these filters." : "Waiting for logs…"}
          </p>
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const entry = filtered[item.index];
              return (
                <div
                  key={entry.id}
                  className="absolute inset-x-0 flex items-center gap-3 px-4 hover:bg-hover"
                  style={{
                    height: ROW_HEIGHT,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <span className={cn("shrink-0 text-xs text-muted", numeric)}>
                    {formatLogTime(entry.t)}
                  </span>
                  <span
                    className={cn(
                      "w-12 shrink-0 rounded-sm px-1 text-center text-xs",
                      numeric,
                      LEVEL_BADGE[entry.level],
                    )}
                  >
                    {entry.level}
                  </span>
                  <span
                    className={cn(
                      "w-40 shrink-0 truncate text-xs text-text-2",
                      numeric,
                    )}
                  >
                    {entry.service}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      numeric,
                      LEVEL_CLASS[entry.level],
                    )}
                  >
                    <Highlight text={entry.message} query={search.trim()} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Marks every case-insensitive occurrence of `query` inside `text`. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  let key = 0;
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-warn-badge px-0.5 text-warn-text"
      >
        {text.slice(at, at + query.length)}
      </mark>,
    );
    from = at + query.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}
