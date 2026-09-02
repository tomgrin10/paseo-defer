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
  writeFileSync(ENTRY, `export * from "./format.shared";\n`);
  try {
    const built = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      external: ["zod", "@getpaseo/plugin/server"],
      absWorkingDir: DIR,
      logLevel: "silent",
    });
    const zod = await import("zod");
    return instantiateBundle(built.outputFiles[0].text, (id) => {
      if (id === "zod") return zod;
      if (id === "@getpaseo/plugin/server") return { defineRpc: (d) => d };
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
