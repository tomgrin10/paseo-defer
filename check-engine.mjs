/**
 * Exercises the scheduler's due-selection against a fake daemon and store.
 *
 * This is the code that decides a message is ready to land in someone's real
 * conversation, and its hardest case has no type and no UI: the provider's
 * usage-window reset is re-derived on every upstream read, so the same rollover
 * comes back with a different fraction of a second each time. Comparing those
 * exactly once made every `sessionReset` message fire on the next refresh,
 * hours early. The instants below are the ones actually recorded when that
 * happened.
 *
 * `engine.server.ts` starts its tick as an import side effect and talks to the
 * daemon, so the two server modules and the lifecycle bridge are replaced with
 * stubs at bundle time and driven from `globalThis`.
 */
import * as esbuild from "esbuild";
import { instantiateBundle } from "./check-lib.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";

const DIR = dirname(fileURLToPath(import.meta.url));

/** What the stubbed store and daemon answer with, and what the store recorded. */
const world = {
  items: [],
  resetsAt: null,
  usageFails: false,
  updates: [],
  lifecycle: { teardown: null },
};
globalThis.__deferCheck = world;

const STUBS = {
  "./store.server": `
    export const store = {
      list: async () => globalThis.__deferCheck.items,
      update: async (id, patch) => {
        globalThis.__deferCheck.updates.push({ id, patch });
        return null;
      },
      recoverInterrupted: async () => 0,
    };
  `,
  "./daemon.server": `
    export const fetchSessionResetsAt = async () => {
      if (globalThis.__deferCheck.usageFails) throw new Error("usage unavailable");
      return globalThis.__deferCheck.resetsAt;
    };
    export const readAgentStates = async () => new Map();
    export const withDaemon = async (work) => work({});
    export const clearCaches = () => {};
  `,
  "./lifecycle.shared": `export const lifecycle = globalThis.__deferCheck.lifecycle;`,
};

const stubPlugin = {
  name: "defer-check-stubs",
  setup(build) {
    build.onResolve({ filter: /^\.\/(store\.server|daemon\.server|lifecycle\.shared)$/ }, (args) => ({
      path: args.path,
      namespace: "defer-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "defer-stub" }, (args) => ({
      contents: STUBS[args.path],
      loader: "js",
    }));
  },
};

async function loadEngine() {
  const built = await esbuild.build({
    entryPoints: [resolve(DIR, "engine.server.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    external: ["zod", "@getpaseo/plugin/server", "node:crypto"],
    plugins: [stubPlugin],
    absWorkingDir: DIR,
    logLevel: "silent",
  });
  return instantiateBundle(built.outputFiles[0].text, (id) => {
    if (id === "node:crypto") return crypto;
    if (id === "zod") return {};
    if (id === "@getpaseo/plugin/server") return { defineRpc: (d) => d };
    throw new Error(`Module "${id}" is not available here`);
  });
}

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(description);
}

/** A queued `sessionReset` message anchored to `anchor`. */
function reset(anchor, id = "r1") {
  return {
    id,
    agentId: "agent",
    text: "x",
    trigger: { kind: "sessionReset" },
    dueAt: anchor,
    anchorResetsAt: anchor,
    createdAt: "2026-09-02T14:02:06.848Z",
    state: "pending",
    settledAt: null,
    error: null,
  };
}

function timed(dueAt, id = "t1") {
  return {
    id,
    agentId: "agent",
    text: "x",
    trigger: { kind: "after", ms: 900_000 },
    dueAt,
    anchorResetsAt: null,
    createdAt: "2026-09-02T14:02:06.848Z",
    state: "pending",
    settledAt: null,
    error: null,
  };
}

const at = (iso) => Date.parse(iso);

// The three values one 15:50 rollover reported on three consecutive reads.
const READS = [
  "2026-09-02T15:49:59.982463+00:00",
  "2026-09-02T15:50:00.077483+00:00",
  "2026-09-02T15:50:00.309167+00:00",
];
const BEFORE = at("2026-09-02T14:03:59.000Z");

try {
  const engine = await loadEngine();
  const { isResetDue, selectDue, resolveDueAt } = engine;

  // The regression. Every pairing of two reads of the same window, an hour and
  // three quarters before it ends, must stay put.
  for (const anchor of READS) {
    for (const current of READS) {
      check(
        isResetDue(reset(anchor), current, BEFORE) === false,
        `a re-read of the same window is not a rollover (anchor ${anchor}, read ${current})`,
      );
    }
  }

  // What must still fire.
  check(
    isResetDue(reset(READS[0]), READS[0], at("2026-09-02T15:50:00.000Z")) === true,
    "the anchor being reached fires it",
  );
  check(
    isResetDue(reset(READS[0]), null, at("2026-09-02T15:49:58.000Z")) === false,
    "a second before the anchor it is not due",
  );
  check(
    isResetDue(reset(READS[0]), "2026-09-02T20:50:00.000Z", BEFORE) === true,
    "a window that now ends five hours later is a rollover we were slow to notice",
  );

  // Where the line sits between the two.
  const anchorMs = at(READS[0]);
  const shifted = (ms) => new Date(anchorMs + ms).toISOString();
  check(isResetDue(reset(READS[0]), shifted(59_000), BEFORE) === false, "59s of drift is the same window");
  check(isResetDue(reset(READS[0]), shifted(61_000), BEFORE) === true, "61s later is a different window");

  // Degenerate anchors must never fire rather than fire at once.
  check(isResetDue({ ...reset(READS[0]), anchorResetsAt: null }, READS[0], BEFORE) === false,
    "an item with no anchor yet is not due");
  check(isResetDue({ ...reset(READS[0]), anchorResetsAt: "not a date" }, READS[0], BEFORE) === false,
    "an unreadable anchor is not due");
  check(isResetDue({ ...reset(READS[0]), anchorResetsAt: READS[0] }, "not a date", BEFORE) === false,
    "an unreadable current read is not a rollover");

  // Now the same thing through selectDue, which is what the tick calls.
  world.resetsAt = READS[2];
  world.updates = [];
  let due = await selectDue([reset(READS[0], "a"), reset(READS[1], "b"), reset(READS[2], "c")], BEFORE);
  check(due.length === 0, "three messages queued against one window all wait");
  check(world.updates.length === 0, "and none of them is rewritten while it waits");

  world.updates = [];
  due = await selectDue([reset(READS[0], "a"), timed("2026-09-02T14:03:00.000Z", "t")], BEFORE);
  check(due.length === 1 && due[0].id === "t", "a timed message due now is still delivered alongside");

  due = await selectDue([reset(READS[0], "a")], at("2026-09-02T15:50:01.000Z"));
  check(due.length === 1 && due[0].id === "a", "past the window end it goes out");

  // An item queued while the window was unreadable adopts the first one it sees.
  world.updates = [];
  due = await selectDue([{ ...reset(READS[0], "a"), anchorResetsAt: null, dueAt: null }], BEFORE);
  check(due.length === 0, "an unanchored item does not fire on the read that anchors it");
  check(
    world.updates.length === 1 &&
      world.updates[0].patch.anchorResetsAt === READS[2] &&
      world.updates[0].patch.dueAt === READS[2],
    "it adopts the window it just read, as both anchor and due date",
  );

  // A window end revised earlier is followed, not fired on.
  world.resetsAt = "2026-09-02T15:20:00.000Z";
  world.updates = [];
  due = await selectDue([reset(READS[0], "a")], BEFORE);
  check(due.length === 0, "a window that now ends earlier does not fire");
  check(
    world.updates.length === 1 && world.updates[0].patch.dueAt === "2026-09-02T15:20:00.000Z",
    "it re-anchors to the earlier end instead",
  );

  // A daemon that cannot answer must hold reset triggers, not release them.
  world.usageFails = true;
  world.updates = [];
  due = await selectDue([reset(READS[0], "a"), timed("2026-09-02T14:03:00.000Z", "t")], BEFORE);
  check(due.length === 1 && due[0].id === "t", "an unreadable usage window holds reset triggers back");
  world.usageFails = false;

  // Timed triggers are resolved up front and carry no anchor.
  const after = await resolveDueAt({ kind: "after", ms: 180_000 }, "2026-09-02T14:00:00.000Z");
  check(after.dueAt === "2026-09-02T14:03:00.000Z" && after.anchorResetsAt === null,
    "an `after` trigger resolves to createdAt plus the wait");
  world.resetsAt = READS[2];
  const onReset = await resolveDueAt({ kind: "sessionReset" }, "2026-09-02T14:00:00.000Z");
  check(onReset.dueAt === READS[2] && onReset.anchorResetsAt === READS[2],
    "a `sessionReset` trigger records the window it was queued against");

  await world.lifecycle.teardown?.();
} catch (error) {
  failures.push(`the engine check could not run: ${error?.stack ?? error}`);
}

console.log("Checking the Defer scheduler...");
for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error(`${failures.length} scheduler check(s) failed`);
  process.exit(1);
}
console.log("  ✓ sessionReset fires on the rollover, not on a re-read of the same window");
console.log("  ✓ timed triggers, first-window adoption and an unreadable daemon all behave");
