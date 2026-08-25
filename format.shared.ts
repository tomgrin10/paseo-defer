import type { Deferred, Trigger } from "./defer.shared";

/** "in 12m", "in 3h 5m", "now", or "2m ago" for an absolute instant. */
export function formatRelative(iso: string | null, from: number = Date.now()): string {
  if (iso === null) return "waiting for usage data";
  const delta = Date.parse(iso) - from;
  const past = delta < 0;
  const total = Math.round(Math.abs(delta) / 1000);
  if (total < 45) return past ? "just now" : "now";
  const minutes = Math.round(total / 60);
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const label = rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  return past ? `${label} ago` : `in ${label}`;
}

/** Local wall-clock time, e.g. "20:50". */
export function formatClock(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Turns "9:30" or "0930" into the next matching instant in local time,
 * rolling to tomorrow when the time has already passed today.
 */
export function parseNextClockTime(raw: string, from: Date = new Date()): string | null {
  const match = /^\s*(\d{1,2})\s*[:.]?\s*(\d{2})?\s*$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const target = new Date(from);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= from.getTime()) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

export function describeTrigger(item: Deferred): string {
  switch (item.trigger.kind) {
    case "after":
      return `${formatClock(item.dueAt)} · ${formatRelative(item.dueAt)}`;
    case "at":
      return `${formatClock(item.dueAt)} · ${formatRelative(item.dueAt)}`;
    case "sessionReset":
      return item.anchorResetsAt === null
        ? "on session reset"
        : `session reset · ${formatRelative(item.anchorResetsAt)}`;
  }
}

/**
 * Whether `next` would deliver at the same moment the item already targets.
 * Editing text alone must not silently restart a relative countdown, so the
 * panel only sends a trigger when this is false.
 */
export function triggersMatch(next: Trigger, item: Deferred): boolean {
  if (next.kind !== item.trigger.kind) return false;
  if (next.kind === "after" && item.trigger.kind === "after") return next.ms === item.trigger.ms;
  // Clock entry only carries hours and minutes, so compare at that resolution.
  if (next.kind === "at") return item.dueAt !== null && formatClock(next.iso) === formatClock(item.dueAt);
  return true;
}

export function stateLabel(item: Deferred): string {
  switch (item.state) {
    case "pending":
      return describeTrigger(item);
    case "sending":
      return "sending…";
    case "sent":
      return `sent ${formatRelative(item.settledAt)}`;
    case "failed":
      return item.error ?? "failed";
    case "cancelled":
      return "cancelled";
  }
}
