"use client";

import { ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { formatAgo, formatClockTime } from "@/lib/metrics";
import { TONE_BADGE, TONE_DOT } from "@/lib/tone";
import {
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATUSES,
  SEVERITIES,
  SEVERITY_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  filterIncidents,
  isActive,
  type IncidentFilters,
} from "@/lib/incidents";
import type { Incident, IncidentSeverity, IncidentStatus } from "@/lib/types";

/**
 * The incident table (SPEC 10). Rows come straight from the store, so the live
 * incident updates its status and recovery time in place while a chaos run is
 * in flight. Newest first; the whole table scrolls horizontally inside the
 * panel rather than squashing columns on a narrow screen.
 */
export function IncidentsTable({
  filters,
  onFiltersChange,
  selectedId,
  onSelect,
}: {
  filters: IncidentFilters;
  onFiltersChange: (next: IncidentFilters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const incidents = useSentinelStore((s) => s.incidents);
  const services = useSentinelStore((s) => s.services);
  const now = useSentinelStore((s) => s.cluster.t);

  const rows = filterIncidents(incidents, filters);
  const activeCount = incidents.filter(isActive).length;
  const patch = (p: Partial<IncidentFilters>) =>
    onFiltersChange({ ...filters, ...p });

  return (
    <Panel>
      <PanelHeader
        title="Incidents"
        actions={
          <span className={cn("text-xs text-muted", numeric)}>
            {rows.length} of {incidents.length}
          </span>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Input
          value={filters.search}
          onChange={(e) => patch({ search: e.target.value })}
          placeholder="Search id or title"
          aria-label="Search incidents"
          className="h-8 w-full sm:w-56"
        />
        <Select
          value={filters.severity}
          onValueChange={(v) =>
            patch({ severity: (v ?? "all") as IncidentSeverity | "all" })
          }
        >
          <SelectTrigger className="h-8" aria-label="Filter by severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.status}
          onValueChange={(v) =>
            patch({ status: (v ?? "all") as IncidentStatus | "all" })
          }
        >
          <SelectTrigger className="h-8" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value="all">All statuses</SelectItem>
            {INCIDENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.service}
          onValueChange={(v) => patch({ service: v ?? "all" })}
        >
          <SelectTrigger className="h-8" aria-label="Filter by service">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value="all">All services</SelectItem>
            {services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {activeCount === 0 ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <ShieldCheck className="size-4 text-ok-text" strokeWidth={1.75} />
          <span className="text-sm text-text-2">
            No active incidents. SentinelOps has your systems covered.
          </span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">
          No incidents match these filters.
        </div>
      ) : (
        <Table className="min-w-[920px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Severity</TableHead>
              <TableHead>Incident</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead>Root cause</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="text-right">Recovery time</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((incident) => (
              <Row
                key={incident.id}
                incident={incident}
                now={now}
                selected={incident.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function Row({
  incident,
  now,
  selected,
  onSelect,
}: {
  incident: Incident;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const severityTone = INCIDENT_SEVERITY_TONE[incident.severity];
  const statusTone = STATUS_TONE[incident.status];
  const live = isActive(incident);

  return (
    <TableRow
      onClick={() => onSelect(incident.id)}
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(incident.id);
        }
      }}
    >
      <TableCell>
        <span className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", TONE_DOT[severityTone])} />
          <span className="text-sm text-text-2">
            {SEVERITY_LABEL[incident.severity]}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className={cn("text-xs text-muted", numeric)}>{incident.id}</span>
        <span className="ml-2 text-sm text-text">{incident.title}</span>
      </TableCell>
      <TableCell className={cn("text-text-2", numeric)}>
        {incident.serviceId}
      </TableCell>
      <TableCell className={cn("text-text-2", numeric)}>
        {formatClockTime(incident.detectedAt)}
        <span className="ml-2 text-xs text-muted">
          {formatAgo(incident.detectedAt, now)}
        </span>
      </TableCell>
      <TableCell className="text-text-2">{incident.rootCause}</TableCell>
      <TableCell className="text-text-2">{incident.action}</TableCell>
      <TableCell className={cn("text-right", numeric)}>
        {incident.recoverySec === undefined ? (
          <span className="text-muted">{live ? "In progress" : "—"}</span>
        ) : (
          <>
            {incident.recoverySec}
            <span className="text-muted"> s</span>
          </>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={TONE_BADGE[statusTone]}>
          {STATUS_LABEL[incident.status]}
        </Badge>
      </TableCell>
    </TableRow>
  );
}
