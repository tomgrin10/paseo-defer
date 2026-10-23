/**
 * Drives the Defer composer as a real component, without a renderer.
 *
 * The timing controls are where a mistake is expensive and invisible: a chip
 * that builds the wrong trigger, a typed wait that quietly re-anchors an
 * existing message, an AM/PM control offered on a device that has no AM/PM.
 * None of that is reachable from `check-format.mjs`, which only sees the
 * parsers, so this mounts the component against a small hook runtime and
 * presses the buttons.
 *
 * It runs itself twice, once under a 12-hour locale and once under a 24-hour
 * one, because half of what it asserts depends on which clock the device uses
 * and neither reading may be left to whatever machine happens to run it.
 */
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const LOCALES = { "en-US": true, "en-GB": false };

// Parent pass: fan out one child per clock convention and report their result.
if (process.env.DEFER_CHECK_LOCALE === undefined) {
  console.log("Checking the Defer composer...");
  let failed = false;
  for (const locale of Object.keys(LOCALES)) {
    const run = spawnSync(process.execPath, [SELF], {
      env: { ...process.env, DEFER_CHECK_LOCALE: locale, LC_ALL: locale, LANG: locale },
      stdio: "inherit",
    });
    failed = failed || run.status !== 0;
  }
  if (failed) {
    console.error("Composer check failed.");
    process.exit(1);
  }
  process.exit(0);
}

const LOCALE = process.env.DEFER_CHECK_LOCALE;
const EXPECT_HOUR12 = LOCALES[LOCALE];
const HOST_TEXT_INPUT = "HostTextInput";

/**
 * Just enough of React to mount one component and keep pressing things: hook
 * slots in call order, a synchronous re-render whenever state changes, and
 * effects flushed after each render.
 */
function createRuntime(Component, props) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let rendering = false;
  let scheduled = false;
  let tree = null;

  const slot = (initial) => {
    if (cursor === slots.length) slots.push(initial());
    return slots[cursor++];
  };
  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function renderNow() {
    rendering = true;
    try {
      for (let pass = 0; pass < 20; pass += 1) {
        cursor = 0;
        effects = [];
        scheduled = false;
        tree = Component(props);
        for (const run of effects) run();
        if (!scheduled) return;
      }
      throw new Error("the composer never settled: a render keeps scheduling another");
    } finally {
      rendering = false;
    }
  }

  function schedule() {
    if (rendering) {
      scheduled = true;
      return;
    }
    renderNow();
  }

  const react = {
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [
        state.value,
        (next) => {
          const value = typeof next === "function" ? next(state.value) : next;
          if (Object.is(value, state.value)) return;
          state.value = value;
          schedule();
        },
      ];
    },
    useRef(initial) {
      return slot(() => ({ current: initial }));
    },
    useMemo(factory, deps) {
      const state = slot(() => ({ deps: null, value: undefined, fresh: false }));
      if (!state.fresh || !sameDeps(state.deps, deps)) {
        state.value = factory();
        state.deps = deps;
        state.fresh = true;
      }
      return state.value;
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const state = slot(() => ({ deps: null, fresh: false }));
      const changed = !state.fresh || deps === undefined || !sameDeps(state.deps, deps);
      state.fresh = true;
      state.deps = deps;
      if (!changed) return;
      effects.push(() => {
        if (typeof state.cleanup === "function") state.cleanup();
        state.cleanup = fn();
      });
    },
    createElement: (type, elementProps, ...children) => ({ type, props: { ...elementProps, children } }),
  };

  return { react, renderNow, tree: () => tree };
}

function* walk(node) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== "object") {
    yield node;
    return;
  }
  yield node;
  yield* walk(node.props?.children);
}

const THEME = {
  colors: {
    surface0: "#000",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    foreground: "#fff",
    foregroundMuted: "#aaa",
    accent: "#88f",
    accentForeground: "#fff",
    statusSuccess: "#0f0",
    statusWarning: "#fa0",
    statusDanger: "#f00",
  },
};

const ENTRY = resolve(DIR, `.check-composer.${LOCALE}.entry.ts`);
const ENTRY_SOURCE = `export { DeferComposer, DeferredRow, deferStyles } from "./client/composer";
export { clockPlaceholder, describeInstant, formatClock, formatDuration, formatResetLabel, uses12HourClock } from "./shared/format";
export { offerComposerDraft } from "./client/handoff";
`;

/** Records every RPC the composer makes, and answers them plausibly. */
function createRpcLog() {
  const calls = [];
  const useRpc = (contract) => async (input) => {
    calls.push({ name: contract.name, input });
    if (contract.name === "defer.create") {
      return {
        item: {
          id: "created",
          agentId: input.agentId,
          text: input.text,
          trigger: input.trigger,
          dueAt: new Date().toISOString(),
          anchorResetsAt: null,
          createdAt: new Date().toISOString(),
          state: "pending",
          settledAt: null,
          error: null,
        },
      };
    }
    if (contract.name === "defer.update") return { item: null, error: null };
    throw new Error(`unexpected rpc ${contract.name}`);
  };
  return { calls, useRpc, of: (name) => calls.filter((call) => call.name === name) };
}

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(`[${LOCALE}] ${description}`);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function loadComposer() {
  writeFileSync(ENTRY, ENTRY_SOURCE);
  try {
    const built = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      external: [
        "react",
        "react/jsx-runtime",
        "react-native",
        "@tanstack/react-query",
        "@getpaseo/plugin",
        "@getpaseo/plugin/client",
        "zod",
      ],
      absWorkingDir: DIR,
      logLevel: "silent",
    });
    return built.outputFiles[0].text;
  } finally {
    rmSync(ENTRY, { force: true });
  }
}

const zod = await import("zod");

/** Stands in for the app's own draft store, which the hand-over reads. */
let composerDraft = "";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () =>
      JSON.stringify({
        state: {
          drafts: {
            "agent:srv_1:agent-1": {
              input: { text: composerDraft, attachments: [] },
              lifecycle: "active",
              updatedAt: 1,
              version: 1,
            },
          },
        },
        version: 5,
      }),
  },
});

async function harness({ editing = null, acceptComposerDraft = false, beforeMount, resetsAt = null } = {}) {
  const rpc = createRpcLog();
  const created = [];
  const saved = [];
  let editingItem = editing;

  const props = {};
  const runtime = createRuntime((p) => graph.DeferComposer(p), props);
  const stubs = {
    react: runtime.react,
    "react/jsx-runtime": {
      Fragment: "Fragment",
      jsx: (type, jsxProps) => ({ type, props: jsxProps }),
      jsxs: (type, jsxProps) => ({ type, props: jsxProps }),
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", TextInput: "NativeTextInput" },
    "@tanstack/react-query": {
      useMutation: ({ mutationFn, onSuccess, onError }) => ({
        isPending: false,
        mutate: (arg) =>
          void Promise.resolve()
            .then(() => mutationFn(arg))
            .then(onSuccess, onError),
      }),
    },
    "@getpaseo/plugin": { defineRpc: (d) => d },
    "@getpaseo/plugin/client": { useRpc: rpc.useRpc },
    "@getpaseo/plugin/client/react-native": { TextInput: HOST_TEXT_INPUT },
  };
  const graph = instantiateBundle(CODE, (id) => {
    if (id === "zod") return zod;
    if (!(id in stubs)) throw new Error(`Module "${id}" is not available in plugin client code`);
    return stubs[id];
  });

  Object.assign(props, {
    theme: THEME,
    styles: graph.deferStyles(THEME, { compact: false, platform: "web" }),
    agentId: "agent-1",
    resetsAt,
    usageError: null,
    editing: editingItem,
    onEditingChange: (item) => {
      editingItem = item;
      props.editing = item;
    },
    onSaved: () => saved.push(true),
    onCreated: (item) => created.push(item),
    acceptComposerDraft,
  });

  // A press reads the composer and opens the panel, in that order, so an offer
  // made here is the one a real panel finds waiting for it.
  beforeMount?.(graph);
  runtime.renderNow();

  const nodes = () => [...walk(runtime.tree())];
  const find = (label) =>
    nodes().find((node) => typeof node === "object" && node.props?.accessibilityLabel === label);
  const text = () => nodes().filter((node) => typeof node === "string").join(" | ");
  return {
    graph,
    rpc,
    created,
    saved,
    find,
    text,
    value: (label) => find(label)?.props.value,
    press: (label) => find(label)?.props.onPress(),
    type: (label, value) => find(label)?.props.onChangeText(value),
    selected: (label) => find(label)?.props.accessibilityState?.selected === true,
  };
}

/** One compile, reused by every mount below. */
const CODE = await loadComposer();

try {
  const ui = await harness();
  const hour12 = ui.graph.uses12HourClock();
  check(hour12 === EXPECT_HOUR12, `the ${LOCALE} locale is read as ${EXPECT_HOUR12 ? "12" : "24"}-hour`);
  check(
    ui.find("Message to defer")?.type === HOST_TEXT_INPUT,
    "the message field uses the host input so mobile keyboard positioning follows focus",
  );

  // Every timing route is offered up front, including the typed ones.
  for (const label of ["Deliver 15m", "Deliver 1h", "Deliver 3h", "Deliver In…", "Deliver At…", "Deliver Session reset"]) {
    check(ui.find(label) !== undefined, `the ${label.replace("Deliver ", "")} option is offered`);
  }
  check(ui.selected("Deliver 15m"), "a preset is chosen to begin with");
  check(ui.find("How long to wait") === undefined, "the wait field stays out of the way until asked for");
  check(ui.find("Delivery time") === undefined, "the time field stays out of the way until asked for");

  // A multi-day provider window needs the date in the compact reset chip. A
  // clock alone looks like the reset is later today, which is especially
  // misleading for Codex windows that can span several days.
  const farReset = new Date(Date.now() + 4 * 24 * 3600_000).toISOString();
  const resetUi = await harness({ resetsAt: farReset });
  const resetDate = resetUi.graph.formatResetLabel(farReset);
  check(resetUi.text().includes(`Session reset · ${resetDate}`), "a multi-day reset chip names its date");
  check(
    !resetUi.text().includes(`Session reset · ${resetUi.graph.formatClock(farReset)}`),
    "a multi-day reset chip does not show only a clock time",
  );
  resetUi.press("Deliver Session reset");
  check(resetUi.text().includes(`Next reset ${resetDate}`), "the selected reset hint names the same date");

  // --- A typed wait: the case no preset chip can cover ---
  ui.press("Deliver In…");
  check(ui.find("How long to wait") !== undefined, "choosing In… reveals the wait field");
  check(ui.find("How long to wait")?.type === HOST_TEXT_INPUT, "the wait field uses the host input");
  check(ui.selected("Deliver In…"), "choosing In… selects it");
  check(ui.text().includes("Minutes unless you say otherwise"), "an empty wait explains what it accepts");

  ui.type("How long to wait", "3");
  check(ui.text().includes("Sends today at"), "a typed wait is resolved to a moment before it is queued");
  check(ui.text().includes("in 3m"), "a typed wait says how long it is");

  ui.type("Message to defer", "three minutes please");
  ui.press("Defer this message");
  await settle();
  const create = ui.rpc.of("defer.create")[0];
  check(create !== undefined, "a typed wait can be queued");
  check(create?.input.trigger.kind === "after" && create.input.trigger.ms === 180_000, "3 is queued as three minutes");
  check(create?.input.text === "three minutes please", "the message is queued as typed");
  check(ui.created.length === 1, "queueing a new message reports back for navigation");
  check(ui.find("Message to defer")?.props.value === "", "a queued message clears the box");

  // A wait the parser cannot read must be reported, not guessed at.
  ui.type("How long to wait", "3d");
  ui.type("Message to defer", "unreadable wait");
  ui.press("Defer this message");
  await settle();
  check(ui.rpc.of("defer.create").length === 1, "an unreadable wait queues nothing");
  check(ui.text().includes("45m"), "an unreadable wait is answered with an example");

  // --- A typed time ---
  ui.press("Deliver At…");
  const field = ui.find("Delivery time");
  check(field !== undefined, "choosing At… reveals the time field");
  check(field?.type === HOST_TEXT_INPUT, "the time field uses the host input");
  check(field?.props.placeholder === ui.graph.clockPlaceholder(hour12), "the time field is prompted in the device's own convention");
  check(ui.text().includes("Local time, 24-hour or with am/pm"), "the time field says which conventions it takes");
  check(
    (ui.find("Deliver in the PM") !== undefined) === hour12,
    "the AM/PM controls appear only where the clock is ambiguous",
  );

  ui.type("Delivery time", "9:30am");
  ui.type("Message to defer", "morning");
  ui.press("Defer this message");
  await settle();
  const morning = ui.rpc.of("defer.create")[1];
  const morningAt = new Date(morning?.input.trigger.iso ?? 0);
  check(morning?.input.trigger.kind === "at", "a typed time is queued as an absolute instant");
  check(
    morningAt.getHours() === 9 && morningAt.getMinutes() === 30,
    "a typed am is honoured whatever the device convention",
  );
  check(morningAt.getTime() > Date.now(), "a time already gone is queued for the next one");

  if (hour12) {
    ui.press("Deliver At…");
    ui.press("Deliver in the PM");
    check(ui.selected("Deliver in the PM"), "the PM control shows as chosen");
    ui.type("Delivery time", "9:30");
    check(ui.text().includes("Sends"), "pinning a half of the day resolves the time");
    ui.press("Deliver in the PM");
    check(!ui.selected("Deliver in the PM"), "pressing the chosen half again releases it");
    ui.press("Deliver in the PM");
    ui.type("Message to defer", "evening");
    ui.press("Defer this message");
    await settle();
    const evening = new Date(ui.rpc.of("defer.create")[2]?.input.trigger.iso ?? 0);
    check(evening.getHours() === 21 && evening.getMinutes() === 30, "the PM control pins the evening");
  } else {
    ui.press("Deliver At…");
    ui.type("Delivery time", "21:30");
    ui.type("Message to defer", "evening");
    ui.press("Defer this message");
    await settle();
    const evening = new Date(ui.rpc.of("defer.create")[2]?.input.trigger.iso ?? 0);
    check(evening.getHours() === 21 && evening.getMinutes() === 30, "a 24-hour time is taken literally");
  }

  ui.press("Deliver At…");
  ui.type("Delivery time", "soon");
  ui.type("Message to defer", "unreadable time");
  const before = ui.rpc.of("defer.create").length;
  ui.press("Defer this message");
  await settle();
  check(ui.rpc.of("defer.create").length === before, "an unreadable time queues nothing");
  check(ui.text().includes(ui.graph.clockPlaceholder(hour12)), "an unreadable time is answered with an example");

  // --- Editing a message that was queued with a typed wait ---
  const queued = {
    id: "queued-1",
    agentId: "agent-1",
    text: "already waiting",
    trigger: { kind: "after", ms: 7 * 60_000 },
    dueAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    anchorResetsAt: null,
    createdAt: new Date().toISOString(),
    state: "pending",
    settledAt: null,
    error: null,
  };
  const edit = await harness({ editing: queued });
  check(edit.selected("Deliver In…"), "editing a typed wait comes back to the In… option");
  check(edit.find("How long to wait")?.props.value === "7m", "editing a typed wait shows the wait, not the clock time");
  check(edit.find("Message to defer")?.props.value === "already waiting", "editing loads the message");
  check(edit.text().includes(`Sends ${edit.graph.describeInstant(queued.dueAt)}.`), "editing confirms the preserved delivery time rather than restarting the shown wait");

  edit.type("Message to defer", "fixed a typo");
  edit.press("Save this deferred message");
  await settle();
  const untouched = edit.rpc.of("defer.update")[0];
  check(untouched !== undefined, "an edit is saved");
  check(untouched?.input.text === "fixed a typo", "an edit saves the new text");
  // The wait round-trips through its own label, so re-saving must not restart it.
  check(untouched?.input.trigger === undefined, "fixing the text of a typed wait does not re-anchor it");

  const retime = await harness({ editing: queued });
  retime.press("Deliver 1h");
  retime.press("Save this deferred message");
  await settle();
  const changed = retime.rpc.of("defer.update")[0];
  check(
    changed?.input.trigger?.kind === "after" && changed.input.trigger.ms === 3_600_000,
    "choosing a different option does re-anchor it",
  );
  check(!("agentId" in changed.input), "an edit leaves the server to resolve its stored target session");
  // --- Text handed over from the session's own composer ---
  composerDraft = "look at the failing test";
  const handed = await harness({
    acceptComposerDraft: true,
    beforeMount: (graph) => graph.offerComposerDraft("agent-1"),
  });
  check(
    handed.value("Message to defer") === "look at the failing test",
    "what was typed in the prompt box is in the message box as the panel opens",
  );

  composerDraft = "a later prompt";
  handed.graph.offerComposerDraft("agent-1");
  check(
    handed.value("Message to defer") === "a later prompt",
    "an untouched hand-over gives way to a newer one",
  );

  handed.type("Message to defer", "my own words");
  composerDraft = "yet another prompt";
  handed.graph.offerComposerDraft("agent-1");
  check(
    handed.value("Message to defer") === "my own words",
    "a hand-over never overwrites a message being written",
  );

  handed.type("Message to defer", "");
  handed.graph.offerComposerDraft("agent-1");
  check(
    handed.value("Message to defer") === "yet another prompt",
    "an emptied box takes the next hand-over",
  );

  handed.press("Defer this message");
  await settle();
  check(handed.value("Message to defer") === "", "queueing a handed-over message clears the box");

  const unasked = await harness({
    beforeMount: (graph) => graph.offerComposerDraft("agent-1"),
  });
  check(
    unasked.value("Message to defer") === "",
    "a view that was not opened from a composer is handed nothing",
  );
  // Send now: a waiting row offers it and passes its item up; a settled or
  // in-flight row offers no way to jump the queue.
  const sendNowLabel = "Send this deferred message now";
  const sent = [];
  const rowFor = (state) =>
    ui.graph.DeferredRow({
      styles: ui.graph.deferStyles(THEME, { compact: false, platform: "web" }),
      item: { id: "row-1", text: "later", state },
      meta: "",
      editing: false,
      onEdit: () => {},
      onSendNow: (item) => sent.push(item.id),
      onCancel: () => {},
    });
  const rowButton = (state) => [...walk(rowFor(state))].find((node) => node?.props?.accessibilityLabel === sendNowLabel);
  rowButton("pending")?.props.onPress();
  check(sent.join() === "row-1", "Send now on a waiting row hands that row up");
  check(rowButton("sending") === undefined, "an in-flight row offers no Send now");
  check(rowButton("sent") === undefined, "a settled row offers no Send now");
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) process.exit(1);
console.log(`  ✓ composer (${LOCALE}): typed waits and times build the right trigger and never re-anchor by accident`);
process.exit(0);
