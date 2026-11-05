import type { Deferred, Trigger } from "./defer";

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

/**
 * Compact provider-reset label. A clock is useful while the reset is less than
 * a day away; beyond that it hides the important part, so name the local
 * calendar date instead. Include the year only when it differs from today.
 */
export function formatResetLabel(
  iso: string | null,
  from: number = Date.now(),
  hour12: boolean = uses12HourClock(),
): string {
  if (iso === null) return "—";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const delta = target - from;
  if (delta >= 0 && delta < DAY_MS) return formatClock(iso, hour12);

  const date = new Date(target);
  const now = new Date(from);
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
    }).format(date);
  } catch {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }
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
 * toast has to carry it: the clock it sends at, then how long that is.
 */
export function queuedLabel(item: Deferred, from: number = Date.now()): string {
  if (item.trigger.kind === "sessionReset") {
    return item.dueAt === null
      ? "Deferred until the session resets"
      : `Deferred until the session resets at ${formatClock(item.dueAt)} \u00b7 ${formatRelative(item.dueAt, from)}`;
  }
  return `Deferred until ${dayPrefix(item.dueAt, from)}${formatClock(item.dueAt)} \u00b7 ${formatRelative(item.dueAt, from)}`;
}

/** Which theme status colour a settled or waiting item should read in. */
export type StateTone = "muted" | "success" | "warning" | "danger";

export function stateTone(item: Deferred): StateTone {
  switch (item.state) {
    case "sent":
      return "success";
    case "failed":
      return "danger";
    // Cancelling is the user's own decision, not something that needs them.
    default:
      return "muted";
  }
}

/** Waiting items, soonest first; an unknown reset instant sorts last. */
export function byDueAt(items: readonly Deferred[]): Deferred[] {
  const at = (item: Deferred) => (item.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(item.dueAt));
  return [...items].sort((a, b) => at(a) - at(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Due already, and held because the session is still busy. */
export function isOverdue(item: Deferred, from: number = Date.now()): boolean {
  return item.state === "pending" && item.dueAt !== null && Date.parse(item.dueAt) <= from;
}

/**
 * A short weekday before a clock that is not today ("Thu 9:30 AM"), and
 * nothing for today, so a time on its own always means today.
 */
function dayPrefix(iso: string | null, from: number): string {
  if (iso === null) return "";
  const days = calendarDays(iso, from);
  if (days <= 0) return "";
  if (days === 1) return "tomorrow ";
  try {
    return `${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(iso))} `;
  } catch {
    return `in ${days} days, `;
  }
}

/** Whole local calendar days from `from`'s date to `iso`'s date. */
function calendarDays(iso: string, from: number): number {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(iso);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

/** "Today", "Yesterday", or a short date, for the activity log's time column. */
export function formatDay(iso: string, from: number = Date.now()): string {
  const days = calendarDays(iso, from);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Composer-pill text, short enough to sit beside Paseo's own pills. It names
 * the next send: a countdown inside the hour, the clock after that, with the
 * count in front once there is more than one ("2 · 4:42 PM").
 */
export function pillLabel(items: readonly Deferred[], from: number = Date.now()): string {
  if (items.length === 0) return "";
  const next = byDueAt(items)[0];
  const when = pillWhen(next, from);
  return items.length > 1 ? `${items.length} \u00b7 ${when}` : when;
}

function pillWhen(item: Deferred, from: number): string {
  if (item.state === "sending") return "sending\u2026";
  if (item.dueAt === null) return "at reset";
  if (isOverdue(item, from)) return "due now";
  if (Date.parse(item.dueAt) - from < HOUR_MS) return formatRelative(item.dueAt, from);
  const day = dayPrefix(item.dueAt, from);
  return `${day === "tomorrow " ? "tmrw " : day}${formatClock(item.dueAt)}`;
}

const HOUR_MS = 60 * MINUTE_MS;

/** "2 deferred · next 7:05 PM": the pill's tooltip and its sheet title on phones. */
export function deferredTitle(items: readonly Deferred[], from: number = Date.now()): string {
  const next = byDueAt(items)[0];
  const when = next.state === "sending" ? "sending now" : next.dueAt === null ? "next at reset" : isOverdue(next, from) ? "next is due now" : `next ${dayPrefix(next.dueAt, from)}${formatClock(next.dueAt)}`;
  return `${items.length} deferred \u00b7 ${when}`;
}

/**
 * A countdown that keeps moving in the last minute ("in 42s") instead of
 * sitting on "now", for views that re-render every second near the end.
 */
export function formatCountdown(iso: string | null, from: number = Date.now()): string {
  if (iso === null) return "waiting for usage data";
  const delta = Date.parse(iso) - from;
  if (delta > 0 && delta < MINUTE_MS) return `in ${Math.max(1, Math.ceil(delta / 1000))}s`;
  return formatRelative(iso, from);
}

/** How one waiting message reads wherever it is listed: the time first. */
export interface When {
  /** The clock it sends at, or a word when there is no clock yet. */
  time: string;
  /** Countdown and qualifiers: "in 47m", "tomorrow · in 20h", "at session reset · in 2h 47m". */
  detail: string;
  /** Pending and in the future, due and held for a busy agent, sending, or reset not yet known. */
  phase: "waiting" | "due" | "sending" | "unknown";
}

export function describeWhen(item: Deferred, from: number = Date.now()): When {
  if (item.state === "sending") return { time: "Sending\u2026", detail: "delivering to the session", phase: "sending" };
  if (item.dueAt === null) return { time: "At reset", detail: "waiting for usage data", phase: "unknown" };
  const time = formatClock(item.dueAt);
  if (isOverdue(item, from)) return { time, detail: "due \u00b7 waits for the agent to finish", phase: "due" };
  const day = dayPrefix(item.dueAt, from).trim();
  const parts = [
    item.trigger.kind === "sessionReset" ? "at session reset" : "",
    day,
    formatCountdown(item.dueAt, from),
  ].filter((part) => part !== "");
  return { time, detail: parts.join(" \u00b7 "), phase: "waiting" };
}

/** How much of a wait is still to run, 1 when just queued and 0 when due. Null without a due time. */
export function remainingFraction(item: Deferred, from: number = Date.now()): number | null {
  if (item.dueAt === null) return null;
  const due = Date.parse(item.dueAt);
  const start = Date.parse(item.createdAt);
  if (!Number.isFinite(due) || !Number.isFinite(start)) return null;
  if (due <= start) return due > from ? 1 : 0;
  return Math.min(1, Math.max(0, (due - from) / (due - start)));
}

export interface DayGroup {
  key: string;
  label: string;
}

/** Which heading a waiting message sorts under on the Deferred screen. */
export function dayGroup(item: Deferred, from: number = Date.now()): DayGroup {
  if (item.state === "sending" || isOverdue(item, from)) return { key: "due", label: "Due now" };
  if (item.dueAt === null) return { key: "reset", label: "At session reset" };
  const days = calendarDays(item.dueAt, from);
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "tomorrow", label: "Tomorrow" };
  let label: string;
  try {
    label = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date(item.dueAt));
  } catch {
    label = `In ${days} days`;
  }
  return { key: `day-${days}`, label };
}

/** The default snooze. */
export const SNOOZE_MS = 10 * MINUTE_MS;

/**
 * A later time for "+10m". It pushes the current send time back, or the
 * present moment when the message is already due and held. Null for a reset
 * trigger, whose time belongs to the provider rather than a clock.
 */
export function snoozeTrigger(item: Deferred, from: number = Date.now(), ms: number = SNOOZE_MS): Trigger | null {
  if (item.trigger.kind === "sessionReset" || item.dueAt === null || item.state !== "pending") return null;
  const base = Math.max(Date.parse(item.dueAt), from);
  return { kind: "at", iso: new Date(base + ms).toISOString() };
}

/** One settled message in the Recent activity log. */
export interface Activity {
  verb: "Sent" | "Cancelled" | "Failed";
  /** Why it failed, or how long it waited past its time for a busy agent. */
  detail: string;
  tone: StateTone;
}

export function describeActivity(item: Deferred): Activity | null {
  switch (item.state) {
    case "sent": {
      const late = item.dueAt === null || item.settledAt === null ? 0 : Date.parse(item.settledAt) - Date.parse(item.dueAt);
      return {
        verb: "Sent",
        detail: late >= 2 * MINUTE_MS ? `waited ${formatDuration(late)} for the agent` : "",
        tone: "success",
      };
    }
    case "cancelled":
      return { verb: "Cancelled", detail: "", tone: "muted" };
    case "failed":
      return { verb: "Failed", detail: item.error ?? "", tone: "danger" };
    default:
      return null;
  }
}

/**
 * The timer glyph: a stopwatch whose ring drains as the wait runs out. Drawn
 * as inline SVG so the host paints it in the surface's own colour; the
 * fraction is rounded to 1/24 so a ticking view redraws it rarely.
 */
export function timerGlyph(fraction: number): string {
  const steps = 24;
  const f = Math.round(Math.min(1, Math.max(0, fraction)) * steps) / steps;
  const r = 8;
  const cx = 12;
  const cy = 13.5;
  let arc = "";
  if (f >= 1) {
    arc = `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  } else if (f > 0) {
    const angle = f * 2 * Math.PI;
    const x = (cx + r * Math.sin(angle)).toFixed(2);
    const y = (cy - r * Math.cos(angle)).toFixed(2);
    arc = `<path d="M${cx} ${cy - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4"/><circle cx="${cx}" cy="${cy}" r="${r}" stroke-opacity="0.32"/>${arc}<path d="M12 13.5L${(cx + 4.5 * Math.sin(f * 2 * Math.PI)).toFixed(2)} ${(cy - 4.5 * Math.cos(f * 2 * Math.PI)).toFixed(2)}"/></svg>`;
}

/** A `/defer` line split into the timing it opens with and the message that follows. */
export interface DeferCommand {
  /** Null when the line named no time, which is not an error: the panel asks. */
  trigger: Trigger | null;
  text: string;
}

/** Words that mean the rolling usage window rather than a clock. */
const RESET_WORDS = new Set(["reset", "session-reset", "sessionreset"]);

/** A second word that can only be the tail of a wait, never the message. */
const WAIT_TAIL = /^\d+(?:\.\d+)?\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i;

const MERIDIEM_WORD = /^(?:am|pm|a\.m\.|p\.m\.)$/i;

/**
 * Reads `2h ship the release notes` — the timing first, then everything else as
 * the message.
 *
 * Only a leading word that can *only* be a time is taken as one, and never more
 * of the line than has to be: `1h 30m` takes both words because `30m` cannot
 * begin a sentence, while `3 more tests` takes only `3` and leaves the rest.
 * `at 9:30 pm`, `in 45m` and `reset` are spelled out for anyone who would
 * rather say it in words. A line that opens with no time at all is not an
 * error — it comes back with a null trigger for the caller to ask about, which
 * is the one thing that must never be guessed.
 */
export function parseDeferCommand(raw: string, options: ClockOptions = {}): DeferCommand {
  const words = raw.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return { trigger: null, text: "" };

  const rest = (taken: number): string => words.slice(taken).join(" ");
  const lead = words[0].toLowerCase();

  if (RESET_WORDS.has(lead)) return { trigger: { kind: "sessionReset" }, text: rest(1) };
  if (lead === "session" && words[1]?.toLowerCase() === "reset") {
    return { trigger: { kind: "sessionReset" }, text: rest(2) };
  }

  // "in …" and "at …" say which reading is meant, so they take a second word
  // that a bare wait would have to earn.
  if (lead === "in" || lead === "at") {
    for (const taken of [3, 2]) {
      const written = words.slice(1, taken).join(" ");
      if (written === "") continue;
      const trigger = lead === "in" ? asWait(written) : asClock(written, options);
      if (trigger !== null) return { trigger, text: rest(taken) };
    }
    // Not a time after all: "at some point" is the start of a message.
  }

  // A bare wait, taking a second word only when it cannot be anything else, and
  // a bare clock time, with its half of the day if that is a separate word.
  const wait = () => {
    if (words[1] !== undefined && WAIT_TAIL.test(words[1])) {
      const pair = asWait(`${words[0]} ${words[1]}`);
      if (pair !== null) return { trigger: pair, text: rest(2) };
    }
    const single = asWait(words[0]);
    return single === null ? null : { trigger: single, text: rest(1) };
  };
  const clock = () => {
    if (words[1] !== undefined && MERIDIEM_WORD.test(words[1])) {
      const pair = asClock(`${words[0]} ${words[1]}`, options);
      if (pair !== null) return { trigger: pair, text: rest(2) };
    }
    const single = asClock(words[0], options);
    return single === null ? null : { trigger: single, text: rest(1) };
  };
  // Written with a colon or a half of the day, it is the time of day: `21:30`
  // here means tonight, the way it does in the panel's own time field. A wait
  // of that length is `21h 30m`, or `in 21:30` for anyone who insists.
  const clockFirst = /[:.]/.test(words[0]) || /(?:am?|pm?)\.?$/i.test(words[0]);
  const read = clockFirst ? (clock() ?? wait()) : (wait() ?? clock());
  if (read !== null) return read;

  return { trigger: null, text: words.join(" ") };
}

function asWait(written: string): Trigger | null {
  const ms = parseDuration(written);
  return ms === null ? null : { kind: "after", ms };
}

function asClock(written: string, options: ClockOptions): Trigger | null {
  // A bare number is a wait, never a time: "15" typed after /defer is minutes.
  if (/^\d+$/.test(written.trim())) return null;
  const iso = parseNextClockTime(written, options);
  return iso === null ? null : { kind: "at", iso };
}
