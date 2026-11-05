/**
 * Exercises the timing parsers and formatters directly.
 *
 * Every one of them decides when a message is actually delivered, from text a
 * user typed, and the interesting cases are the ones no type can catch: "9:30"
 * in the afternoon on an AM/PM device, a bare "3" meaning minutes, a wait
 * longer than the plugin will accept. They are pure functions, so this drives
 * them with a fixed `from` and an explicit clock convention rather than
 * whatever locale and time the machine running the check happens to have.
 */
import * as esbuild from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, ".check-format.entry.ts");

async function loadFormat() {
  writeFileSync(ENTRY, `export * from "./shared/format";\n`);
  try {
    const built = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      external: ["zod", "@getpaseo/plugin"],
      absWorkingDir: DIR,
      logLevel: "silent",
    });
    const zod = await import("zod");
    return instantiateBundle(built.outputFiles[0].text, (id) => {
      if (id === "zod") return zod;
      if (id === "@getpaseo/plugin") return { defineRpc: (d) => d };
      throw new Error(`Module "${id}" is not available here`);
    });
  } finally {
    rmSync(ENTRY, { force: true });
  }
}

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(description);
}

/** Local wall-clock reading of a parsed instant, as "YYYY-MM-DD HH:MM". */
function localOf(iso) {
  if (iso === null) return "null";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

try {
  const f = await loadFormat();

  // Wednesday 2 September 2026, mid-afternoon, in whatever zone this runs in.
  const from = new Date(2026, 8, 2, 15, 0, 0, 0);

  // --- The clock, written the way the device reads ---
  const evening = new Date(2026, 8, 2, 20, 50).toISOString();
  check(f.formatClock(evening, false) === "20:50", "a 24-hour clock is zero padded");
  check(f.formatClock(evening, true) === "8:50 PM", "a 12-hour clock carries PM");
  check(f.formatClock(new Date(2026, 8, 2, 0, 5).toISOString(), true) === "12:05 AM", "midnight is 12 AM");
  check(f.formatClock(new Date(2026, 8, 2, 12, 5).toISOString(), true) === "12:05 PM", "noon is 12 PM");
  check(f.formatClock(null, true) === "—", "an unknown time has a placeholder");
  const withinDay = new Date(from.getTime() + 23 * 3600_000).toISOString();
  const afterDay = new Date(from.getTime() + 25 * 3600_000).toISOString();
  const expectedDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(afterDay),
  );
  check(
    f.formatResetLabel(withinDay, from.getTime(), false) === f.formatClock(withinDay, false),
    "a reset inside the next 24 hours shows its clock time",
  );
  check(
    f.formatResetLabel(afterDay, from.getTime(), false) === expectedDate,
    "a reset more than 24 hours away shows its calendar date",
  );
  check(f.formatResetLabel(null, from.getTime(), false) === "—", "an unknown reset has a placeholder");
  check(f.clockPlaceholder(true) === "9:30 PM", "an AM/PM device is prompted with AM/PM");
  check(f.clockPlaceholder(false) === "21:30", "a 24-hour device is prompted with 24-hour time");
  // Whatever the convention, a shown time must be typeable straight back in.
  for (const hour12 of [false, true]) {
    const shown = f.formatClock(evening, hour12);
    check(
      localOf(f.parseNextClockTime(shown, { from, hour12 })) === "2026-09-02 20:50",
      `a formatted time parses back as itself (hour12: ${hour12})`,
    );
  }

  // --- Typed times ---
  const at = (raw, options) => localOf(f.parseNextClockTime(raw, { from, ...options }));
  check(at("21:30", { hour12: false }) === "2026-09-02 21:30", "an evening 24-hour time stays today");
  check(at("2130", { hour12: false }) === "2026-09-02 21:30", "a separator is optional");
  check(at("9.30", { hour12: false }) === "2026-09-03 09:30", "a time already gone rolls to tomorrow");
  check(at("930", { hour12: false }) === "2026-09-03 09:30", "three digits read as h:mm");
  check(at("7", { hour12: false }) === "2026-09-03 07:00", "a bare hour needs no minutes");
  check(at("7", { hour12: true }) === "2026-09-02 19:00", "an AM/PM device reads a bare 7 as this evening");
  // The reason this exists: on an AM/PM device "9:30" in the afternoon means
  // tonight. Reading it as 24-hour time silently delivered it tomorrow.
  check(at("9:30", { hour12: true }) === "2026-09-02 21:30", "a bare 1-12 takes the sooner half of the day");
  check(at("9:30", { hour12: false }) === "2026-09-03 09:30", "a 24-hour device reads a bare hour literally");
  check(at("9:30am", { hour12: true }) === "2026-09-03 09:30", "a typed am pins the morning");
  check(at("9:30 PM", { hour12: false }) === "2026-09-02 21:30", "a typed pm overrides the device convention");
  check(at("9:30", { hour12: true, meridiem: "am" }) === "2026-09-03 09:30", "the AM control pins the morning");
  check(at("9:30", { hour12: true, meridiem: "pm" }) === "2026-09-02 21:30", "the PM control pins the evening");
  check(at("9:30am", { hour12: true, meridiem: "pm" }) === "2026-09-03 09:30", "typed text beats the control");
  check(at("16:00", { hour12: true }) === "2026-09-02 16:00", "an unambiguous hour is never re-read");
  check(at("13:00", { hour12: true, meridiem: "pm" }) === "null", "a 24-hour hour with a half is a mistake");
  check(at("25:00", { hour12: false }) === "null", "an impossible hour is rejected");
  check(at("9:70", { hour12: false }) === "null", "an impossible minute is rejected");
  check(at("", { hour12: false }) === "null", "an empty time is rejected");
  check(at("soon", { hour12: false }) === "null", "unreadable text is rejected");

  // --- Typed waits ---
  const MINUTE = 60_000;
  const wait = (raw) => f.parseDuration(raw);
  check(wait("3") === 3 * MINUTE, "a bare number is minutes");
  check(wait("45m") === 45 * MINUTE, "m is minutes");
  check(wait("45 minutes") === 45 * MINUTE, "a spelled-out unit reads the same");
  check(wait("2h") === 120 * MINUTE, "h is hours");
  check(wait(" 2 HOURS ") === 120 * MINUTE, "case and padding do not matter");
  check(wait("1.5h") === 90 * MINUTE, "a fractional hour is allowed");
  check(wait("1h30") === 90 * MINUTE, "a trailing number after hours is minutes");
  check(wait("1h 30m") === 90 * MINUTE, "hours and minutes combine");
  check(wait("1:30") === 90 * MINUTE, "a colon reads as hours and minutes");
  check(wait("90") === 90 * MINUTE, "minutes may exceed an hour");
  check(wait("0") === null, "a zero wait is not a wait");
  check(wait("") === null, "an empty wait is rejected");
  check(wait("3d") === null, "an unsupported unit is rejected rather than guessed");
  check(wait("later") === null, "unreadable text is rejected");
  check(wait("43200m") === 30 * 24 * 60 * MINUTE, "the longest accepted wait is 30 days");
  check(wait("43201m") === null, "a wait beyond the limit is rejected");
  check(f.parseDuration("30") === f.MIN_DELAY_MS * 30, "the minimum wait is one minute");
  check(f.MAX_DELAY_MS === 30 * 24 * 60 * MINUTE, "the maximum wait is 30 days");

  // A wait shown back to the user must survive a round trip through the field.
  for (const raw of ["3", "45m", "2h", "1h30", "1:30", "23h 59m", "43200m"]) {
    const ms = f.parseDuration(raw);
    check(f.parseDuration(f.formatDuration(ms)) === ms, `a wait round-trips its own label (${raw})`);
  }
  check(f.formatDuration(3 * MINUTE) === "3m", "a short wait reads in minutes");
  check(f.formatDuration(90 * MINUTE) === "1h 30m", "a mixed wait reads in both");
  check(f.formatDuration(120 * MINUTE) === "2h", "a whole wait drops the minutes");

  // --- Saying out loud what was chosen ---
  const soon = new Date(from.getTime() + 3 * MINUTE).toISOString();
  check(
    f.describeInstant(soon, from) === `today at ${f.formatClock(soon)} · in 3m`,
    "a wait resolves to a time today",
  );
  check(
    f.describeInstant(new Date(2026, 8, 3, 9, 30).toISOString(), from).startsWith("tomorrow at "),
    "the next day is named tomorrow",
  );
  const farOff = f.describeInstant(new Date(2026, 8, 9, 9, 30).toISOString(), from);
  check(
    !farOff.startsWith("today") && !farOff.startsWith("tomorrow") && farOff.includes("in 6d"),
    "a date further out is named, not counted in hours",
  );
  check(f.formatRelative(new Date(from.getTime() + 47 * 3600_000).toISOString(), from.getTime()) === "in 47h",
    "under two days still counts in hours");
  check(f.formatRelative(new Date(from.getTime() + 50 * 3600_000).toISOString(), from.getTime()) === "in 2d 2h",
    "beyond two days counts in days");
  // --- Reading a `/defer` line: the timing first, the message after ---
  const line = (raw) => f.parseDeferCommand(raw, { from, hour12: false });
  const said = (raw) => {
    const { trigger, text } = line(raw);
    if (trigger === null) return `— ${text}`;
    if (trigger.kind === "after") return `${f.formatDuration(trigger.ms)} ${text}`;
    if (trigger.kind === "sessionReset") return `reset ${text}`;
    return `${localOf(trigger.iso)} ${text}`;
  };

  check(said("2h ship the release notes") === "2h ship the release notes", "a wait opens the line");
  check(said("1h 30m ship it") === "1h 30m ship it", "a two-word wait is taken whole");
  check(said("in 45m ship it") === "45m ship it", "the wait can be said in words");
  check(said("15") === "15m ", "a bare number is minutes, message or no message");
  check(said("at 21:30 ship it") === "2026-09-02 21:30 ship it", "a clock time can be spelled out");
  check(said("21:30 ship it") === "2026-09-02 21:30 ship it", "or written on its own");
  check(said("9:30 pm ship it") === "2026-09-02 21:30 ship it", "with its half of the day apart");
  check(said("reset ship it") === "reset ship it", "the usage window is a word");
  check(said("session reset ship it") === "reset ship it", "said either way");

  // The line is only read as a time when it can only be a time.
  check(said("3 more tests please") === "3m more tests please", "a leading number is still a wait");
  check(said("ship it in 2h") === "— ship it in 2h", "a time later in the line is left alone");
  check(said("at some point, ship it") === "— at some point, ship it", "\"at\" is not always a time");
  check(said("in the morning, ship it") === "— in the morning, ship it", "nor is \"in\"");
  check(said("resetting the box") === "— resetting the box", "nor is a word that merely starts like one");
  check(said("2 more tests") === "2m more tests", "a wait takes no more of the line than it must");
  check(said("") === "— ", "an empty line asks for nothing");
  check(said("   ") === "— ", "and neither does an empty-looking one");
  check(said("90d ship it") === "— 90d ship it", "a wait beyond the limit is not a wait at all");
  // A colon is the one form both readings claim; the time of day wins it.
  check(said("21:30 ship it") === "2026-09-02 21:30 ship it", "a colon reads as the time of day");
  check(said("in 21:30 ship it") === "21h 30m ship it", "saying \"in\" claims it back as a wait");
  check(said("1h30 ship it") === "1h 30m ship it", "an unpunctuated wait stays a wait");

  // --- How a waiting message is shown: the time first, everywhere ---
  const nowMs = new Date(2026, 8, 2, 14, 0, 0).getTime();
  const atMin = (minutes) => new Date(nowMs + minutes * 60_000).toISOString();
  const queued = (id, minutes, extra = {}) => ({
    id, agentId: "agent", text: id, trigger: { kind: "after", ms: 3_600_000 }, dueAt: minutes === null ? null : atMin(minutes),
    anchorResetsAt: null, createdAt: atMin(-60), state: "pending", settledAt: null, error: null, ...extra,
  });
  const clock12 = (minutes) => f.formatClock(atMin(minutes));

  // The pill: a countdown inside the hour, a clock after it, the count first.
  check(f.pillLabel([queued("a", 47)], nowMs) === "in 47m", "a send inside the hour counts down");
  check(f.pillLabel([queued("a", 150)], nowMs) === clock12(150), "a later send today is its clock time");
  check(f.pillLabel([queued("a", 150), queued("b", 20)], nowMs) === "2 · in 20m", "several lead with the count and the soonest send");
  check(f.pillLabel([queued("a", -5)], nowMs) === "due now", "a due message held for a busy agent says so");
  check(f.pillLabel([queued("a", null, { trigger: { kind: "sessionReset" } })], nowMs) === "at reset", "an unread reset has no clock to show");
  check(f.pillLabel([queued("a", 20 * 60)], nowMs).startsWith("tmrw "), "tomorrow is named, briefly");
  check(f.pillLabel([queued("a", 20, { state: "sending" }), queued("b", 90)], nowMs) === "2 · sending…", "sending outranks the clock");
  check(f.deferredTitle([queued("a", 150), queued("b", 300)], nowMs) === `2 deferred · next ${clock12(150)}`, "the pill's title summarises without quoting messages");

  // Rows: the clock, then what it means.
  const when = f.describeWhen(queued("a", 47), nowMs);
  check(when.time === clock12(47) && when.detail === "in 47m" && when.phase === "waiting", "a row leads with the clock and counts down beside it");
  const resetWhen = f.describeWhen(queued("a", 165, { trigger: { kind: "sessionReset" } }), nowMs);
  check(resetWhen.detail === "at session reset · in 2h 45m", "a reset row says it waits for the reset");
  check(f.describeWhen(queued("a", -5), nowMs).phase === "due", "a held row is marked due");
  check(f.describeWhen(queued("a", 20 * 60), nowMs).detail.startsWith("tomorrow · "), "a row for tomorrow says tomorrow");
  check(f.formatCountdown(atMin(0.7), nowMs) === "in 42s", "the last minute counts seconds");

  // The timer glyph drains as the wait runs out.
  check(f.remainingFraction(queued("a", 60), nowMs) === 0.5, "half the wait left reads as half");
  check(f.remainingFraction(queued("a", -1), nowMs) === 0, "a due message has nothing left");
  check(f.remainingFraction(queued("a", null), nowMs) === null, "no due time, no fraction");
  const full = f.timerGlyph(1);
  const half = f.timerGlyph(0.5);
  check(full.startsWith("<svg") && full.includes("currentColor") && !/script|style|on[a-z]+=/i.test(full), "the glyph is plain SVG painted in the host colour");
  check(full !== half && f.timerGlyph(0.501) === half, "the glyph changes with the wait, in steps a ticking view barely redraws");

  // Day groups on the Deferred screen.
  check(f.dayGroup(queued("a", 30), nowMs).label === "Today", "later today is Today");
  check(f.dayGroup(queued("a", 20 * 60), nowMs).label === "Tomorrow", "tomorrow is Tomorrow");
  check(f.dayGroup(queued("a", -5), nowMs).key === "due", "a held message sorts under Due now");
  check(f.dayGroup(queued("a", null), nowMs).key === "reset", "an unread reset sorts under At session reset");
  check(f.byDueAt([queued("late", 90), queued("none", null), queued("soon", 10)]).map((i) => i.id).join() === "soon,late,none", "the schedule runs soonest first");

  // +10m pushes the send back, from nowMs when it is already due.
  check(f.snoozeTrigger(queued("a", 47), nowMs)?.iso === atMin(57), "+10m moves a waiting message ten minutes later");
  check(f.snoozeTrigger(queued("a", -5), nowMs)?.iso === atMin(10), "+10m moves a held message to ten minutes from now");
  check(f.snoozeTrigger(queued("a", 165, { trigger: { kind: "sessionReset" } }), nowMs) === null, "a reset trigger is not a clock to push");
  check(f.snoozeTrigger(queued("a", 47, { state: "sending" }), nowMs) === null, "a message on its way cannot be snoozed");

  // Recent activity names the outcome.
  check(f.describeActivity(queued("a", -30, { state: "sent", settledAt: atMin(-20) }))?.detail === "waited 10m for the agent", "a late send says how long it waited");
  check(f.describeActivity(queued("a", -30, { state: "sent", settledAt: atMin(-30) }))?.detail === "", "an on-time send needs no note");
  check(f.describeActivity(queued("a", -30, { state: "failed", error: "The target session is gone." }))?.detail === "The target session is gone.", "a failure says why");
  check(f.describeActivity(queued("a", 30, { state: "cancelled" }))?.tone === "muted", "a cancel is the user's own choice, not a warning");
  check(f.describeActivity(queued("a", 30)) === null, "a waiting message is not activity");
  check(f.formatDay(atMin(-60), nowMs) === "Today" && f.formatDay(atMin(-24 * 60), nowMs) === "Yesterday", "recent days are named");

  // The toast names the clock as well as the wait.
  check(f.queuedLabel(queued("a", 60, { trigger: { kind: "after", ms: 3_600_000 } }), nowMs) === `Deferred until ${clock12(60)} · in 1h`, "the toast says exactly when");
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

console.log("Checking timing parsers...");
for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Timing parser check failed.");
  process.exit(1);
}
console.log("  ✓ timing: waits and clock times parse, resolve, and round-trip as written");
process.exit(0);
