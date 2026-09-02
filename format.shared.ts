import type { Deferred, Trigger } from "./defer.shared";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Bounds on a typed wait. The scheduler ticks every 15s, so anything under a
 * minute would land at a time nobody really chose, and a month is already far
 * past the point where a relative delay is the right way to say it.
 */
export const MIN_DELAY_MS = MINUTE_MS;
export const MAX_DELAY_MS = 30 * DAY_MS;

/** "in 12m", "in 3h 5m", "in 2d 4h", "now", or "2m ago" for an absolute instant. */
export function formatRelative(iso: string | null, from: number = Date.now()): string {
  if (iso === null) return "waiting for usage data";
  const delta = Date.parse(iso) - from;
  const past = delta < 0;
  const total = Math.round(Math.abs(delta) / 1000);
  if (total < 45) return past ? "just now" : "now";
  const minutes = Math.round(total / 60);
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const label = hours < 48 ? hoursAndMinutes(hours, minutes % 60) : daysAndHours(hours);
  return past ? `${label} ago` : `in ${label}`;
}

function hoursAndMinutes(hours: number, minutes: number): string {
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function daysAndHours(hours: number): string {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

let cachedHour12: boolean | null = null;

/**
 * Whether this device writes times with AM/PM. Read once from the host locale;
 * where `Intl` cannot answer, a 24-hour clock is the safer assumption because
 * it is the reading that cannot be misheard.
 */
export function uses12HourClock(): boolean {
  if (cachedHour12 !== null) return cachedHour12;
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).formatToParts(
      new Date(2020, 0, 1, 13, 0, 0),
    );
    cachedHour12 = parts.some((part) => part.type === "dayPeriod");
  } catch {
    cachedHour12 = false;
  }
  return cachedHour12;
}

/** Local wall-clock time in the device's own convention: "20:50" or "8:50 PM". */
export function formatClock(iso: string | null, hour12: boolean = uses12HourClock()): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (!hour12) return `${String(hours).padStart(2, "0")}:${minutes}`;
  // Written exactly the way the time field reads it back, so anything shown
  // here can be typed straight in again.
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/** What an empty time field should suggest, in the convention the device uses. */
export function clockPlaceholder(hour12: boolean = uses12HourClock()): string {
  return hour12 ? "9:30 PM" : "21:30";
}

export type Meridiem = "am" | "pm";

export interface ClockOptions {
  from?: Date;
  /** Applied when the text itself carries no AM/PM. */
  meridiem?: Meridiem | null;
  /** Whether a bare 1–12 may mean either half of the day. */
  hour12?: boolean;
}

const CLOCK_PATTERN = /^\s*(\d{1,2})\s*[:.]?\s*(\d{2})?\s*(am?|pm?)?\.?\s*$/i;

/**
 * Turns "9:30", "0930", "21:30" or "9:30 pm" into the next matching instant in
 * local time, rolling past `from` once that time has gone.
 *
 * A bare 1–12 on an AM/PM device is deliberately not read as 24-hour time:
 * "9:30" typed in the afternoon means tonight, not tomorrow morning. It
 * resolves to whichever reading comes first, and typing "am"/"pm" — or the
 * caller passing `meridiem` — pins it.
 */
export function parseNextClockTime(raw: string, options: ClockOptions = {}): string | null {
  const { from = new Date(), meridiem = null, hour12 = uses12HourClock() } = options;
  const match = CLOCK_PATTERN.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (minutes > 59) return null;
  const typed = match[3] === undefined ? null : match[3][0].toLowerCase() === "a" ? "am" : "pm";
  const half: Meridiem | null = typed ?? meridiem;
  if (half !== null) {
    if (hours < 1 || hours > 12) return null;
    return nextClockInstant(from, half === "pm" ? (hours % 12) + 12 : hours % 12, minutes);
  }
  if (hours > 23) return null;
  const literal = nextClockInstant(from, hours, minutes);
  if (!hour12 || hours < 1 || hours > 12) return literal;
  // Ambiguous: take the sooner of the two halves of the day.
  const other = nextClockInstant(from, (hours + 12) % 24, minutes);
  return Date.parse(other) < Date.parse(literal) ? other : literal;
}

/** The next instant at this local hour and minute, strictly after `from`. */
function nextClockInstant(from: Date, hours: number, minutes: number): string {
  const target = new Date(from);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= from.getTime()) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

const DURATION_PATTERN =
  /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes)?)?$/;

/**
 * Reads a typed wait. A bare number is minutes, because a short nudge is the
 * case a preset chip cannot cover: "3" is three minutes. "45m", "2h", "1.5h",
 * "1h30", "1h 30m" and "1:30" all read as written. Null for anything
 * unreadable or outside `MIN_DELAY_MS`…`MAX_DELAY_MS`, which the caller shows
 * as a hint rather than silently rounding into range.
 */
export function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return null;
  // "1:30" is the one form where the leading number is hours without saying so.
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(text);
  if (clock) return boundedDelay((Number(clock[1]) * 60 + Number(clock[2])) * MINUTE_MS);
  const match = DURATION_PATTERN.exec(text);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  return boundedDelay(Math.round((hours * 60 + minutes) * MINUTE_MS));
}

function boundedDelay(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < MIN_DELAY_MS || ms > MAX_DELAY_MS) return null;
  return ms;
}

/** A wait written the way `parseDuration` reads it back: "3m", "1h 30m", "2h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  return hoursAndMinutes(Math.floor(minutes / 60), minutes % 60);
}

/**
 * "today at 9:30 PM · in 4h 12m" — the whole point of which is to say out loud
 * what a typed time or wait resolved to, before it is queued.
 */
export function describeInstant(iso: string, from: Date = new Date()): string {
  return `${describeDay(iso, from)} at ${formatClock(iso)} · ${formatRelative(iso, from.getTime())}`;
}

function describeDay(iso: string, from: Date): string {
  const midnight = new Date(from);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((Date.parse(iso) - midnight.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(
      new Date(iso),
    );
  } catch {
    return `in ${days} days`;
  }
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

/**
 * Confirmation for a freshly queued message. Views that return to the session
 * after deferring hide the list that would otherwise show the timing, so the
 * toast has to carry it.
 */
export function queuedLabel(item: Deferred): string {
  if (item.trigger.kind === "sessionReset") {
    return item.anchorResetsAt === null
      ? "Deferred until the session resets"
      : `Deferred until the session resets ${formatRelative(item.anchorResetsAt)}`;
  }
  return `Deferred \u00b7 sending ${formatRelative(item.dueAt)} (${formatClock(item.dueAt)})`;
}

/** Which theme status colour a settled or waiting item should read in. */
export type StateTone = "muted" | "success" | "warning" | "danger";

export function stateTone(item: Deferred): StateTone {
  switch (item.state) {
    case "sent":
      return "success";
    case "failed":
      return "danger";
    case "cancelled":
      return "warning";
    default:
      return "muted";
  }
}

/**
 * Composer-pill text. One line, short enough to sit beside Paseo's own pills:
 * a single message shows when it lands, several show only the count.
 */
export function pillLabel(items: readonly Deferred[]): string {
  if (items.length === 0) return "";
  if (items.length > 1) return `${items.length} deferred`;
  const [item] = items;
  if (item.state === "sending") return "sending…";
  if (item.trigger.kind === "sessionReset") {
    return item.anchorResetsAt === null ? "on reset" : `reset ${formatRelative(item.anchorResetsAt)}`;
  }
  return formatRelative(item.dueAt);
}
