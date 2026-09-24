/**
 * Drives the composer-pill client entrypoint outside the app.
 *
 * `check-bundles.mjs` proves the client entry is registered; this proves the
 * contribution behaves: one pill per session that has something waiting, none
 * for an empty queue, a panel opened on press, and every timer and
 * subscription released on cleanup. Paseo tears the entrypoint down on reload,
 * disable and disconnect, and a leaked interval there is the same class of bug
 * that once wedged this plugin's "Stopping plugin" step.
 */
import * as esbuild from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Enough of React to call the pill component as a plain function and read the
 * element tree back. The component only uses hooks that are pure per render,
 * so this stays a straight function call with no renderer involved.
 */
const react = {
  useCallback: (fn) => fn,
  // Nothing here re-renders, so a setter is a no-op: the component's only state
  // is the chip it is waiting on, which is cosmetic.
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
};

const jsxRuntime = {
  Fragment: "Fragment",
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
};

/** Theme tokens Paseo passes to a pill; only their presence matters here. */
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

const HOST_PROPS = { theme: THEME, host: { id: "host", label: "Host" }, layout: { compact: false, platform: "web" } };

/** Every node of an element tree, elements and text alike. */
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

const render = (Component, props) => Component({ ...HOST_PROPS, ...props });

/** The preview card, identified the way a screen reader would find it. */
const cardOf = (tree) =>
  [...walk(tree)].find(
    (node) => typeof node === "object" && node.props?.accessibilityLabel === "Open the Defer panel",
  );

const textOf = (tree) => [...walk(tree)].filter((node) => typeof node === "string").join(" ");

/** What the pill said out loud, in the order it said it. */
const toasts = {
  shown: [],
  errors: [],
  show(message) {
    toasts.shown.push(message);
  },
  error(message) {
    toasts.errors.push(message);
  },
};

/** Host modules Paseo provides to client code; anything else must fail. */
const STUBS = {
  react,
  "react/jsx-runtime": jsxRuntime,
  "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
  "@tanstack/react-query": {},
  "@getpaseo/plugin": { defineRpc: (d) => d },
  "@getpaseo/plugin/client": {},
  "@getpaseo/plugin/client/react-native": {
    Icon: () => null,
    Modal: () => null,
    useToast: () => toasts,
  },
};

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(description);
}

/**
 * One bundle for the whole client graph, so the entrypoint and the notifier
 * share a module instance exactly as they do inside Paseo's client bundle.
 */
const ENTRY = resolve(DIR, ".check-pill.entry.ts");
const ENTRY_SOURCE = `export { contributeClient } from "./client/pill";
export { notifyDeferChanged } from "./client/refresh";
export { pillLabel } from "./shared/format";
export { onComposerDraftOffered } from "./client/handoff";
`;

async function loadClientGraph() {
  writeFileSync(ENTRY, ENTRY_SOURCE);
  try {
    const built = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      external: [...Object.keys(STUBS), "zod"],
      absWorkingDir: DIR,
      logLevel: "silent",
    });
    const zod = await import("zod");
    return instantiateBundle(built.outputFiles[0].text, (id) => {
      if (id === "zod") return zod;
      if (!(id in STUBS)) throw new Error(`Module "${id}" is not available in plugin client code`);
      return STUBS[id];
    });
  } finally {
    rmSync(ENTRY, { force: true });
  }
}

/** Counts outstanding timers so cleanup can be checked for leaks. */
function installTimerTracker() {
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const live = new Set();
  const track = (name) =>
    (callback, ...rest) => {
      let handle;
      const wrapped =
        name === "setTimeout"
          ? (...args) => {
              live.delete(handle);
              callback(...args);
            }
          : callback;
      handle = real[name](wrapped, ...rest);
      live.add(handle);
      return handle;
    };
  const release = (name) => (handle) => {
    live.delete(handle);
    return real[name](handle);
  };
  globalThis.setInterval = track("setInterval");
  globalThis.setTimeout = track("setTimeout");
  globalThis.clearInterval = release("clearInterval");
  globalThis.clearTimeout = release("clearTimeout");
  return {
    live,
    real,
    restore() {
      Object.assign(globalThis, real);
    },
  };
}

function deferred(id, agentId, dueInMs, state = "pending") {
  const now = Date.now();
  return {
    id,
    agentId,
    text: `message ${id}`,
    trigger: { kind: "after", ms: dueInMs },
    dueAt: new Date(now + dueInMs).toISOString(),
    anchorResetsAt: null,
    createdAt: new Date(now).toISOString(),
    state,
    settledAt: state === "pending" ? null : new Date(now).toISOString(),
    error: null,
  };
}

/** Records what the entrypoint asks Paseo to do. */
function createFakeClient({ items, agents, pillMode }) {
  const pills = [];
  const opened = [];
  const created = [];
  let agentHandler = null;
  let observationHandler = null;
  let unsubscribed = false;
  let observationSubscribed = false;
  let observationListenerRemoved = false;
  let observationReleased = false;
  let listCalls = 0;
  let lastListOptions;
  return {
    pills,
    opened,
    created,
    get listCalls() {
      return listCalls;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    get observationReleased() {
      return observationReleased;
    },
    get observationSubscribed() {
      return observationSubscribed;
    },
    get observationListenerRemoved() {
      return observationListenerRemoved;
    },
    get lastListOptions() {
      return lastListOptions;
    },
    emitAgent(agent) {
      agentHandler?.({ kind: "upsert", agent });
      observationHandler?.update({ type: "agent_update", payload: { kind: "upsert", agent } });
    },
    emitRemove(agentId) {
      agentHandler?.({ kind: "remove", agentId });
      observationHandler?.update({ type: "agent_update", payload: { kind: "remove", agentId } });
    },
    emitObservationSnapshot(nextAgents) {
      observationHandler?.snapshot({
        requestId: "req",
        entries: nextAgents.map((agent) => ({ agent })),
        pageInfo: {},
      });
    },
    client: {
      paseo: {
        agents: {
          subscribe(handler) {
            agentHandler = handler;
            return () => {
              unsubscribed = true;
              agentHandler = null;
            };
          },
          async list(options) {
            listCalls += 1;
            lastListOptions = options;
            return {
              requestId: "req",
              entries: agents().map((agent) => ({ agent })),
              pageInfo: {},
              subscription: {
                subscribe(observer) {
                  observationSubscribed = true;
                  observationHandler = observer;
                  return () => {
                    observationListenerRemoved = true;
                    observationHandler = null;
                  };
                },
                async release() {
                  observationReleased = true;
                },
              },
            };
          },
        },
      },
      async rpc(contract, input) {
        if (contract.name === "defer.create") {
          created.push(input);
          return {
            item: {
              id: `created-${created.length}`,
              agentId: input.agentId,
              text: input.text,
              trigger: input.trigger,
              dueAt: new Date(Date.now() + (input.trigger.ms ?? 0)).toISOString(),
              anchorResetsAt: null,
              createdAt: new Date().toISOString(),
              state: "pending",
              settledAt: null,
              error: null,
            },
          };
        }
        if (contract.name !== "defer.list") throw new Error(`unexpected rpc ${contract.name}`);
        return {
          items: items(),
          sessionResetsAt: null,
          usageError: null,
          settings: { pillMode: pillMode() },
        };
      },
      openSurface() {},
      openPanel(id, options) {
        opened.push({ id, options });
      },
      addComposerPill(contribution) {
        const entry = { contribution, removed: false };
        pills.push(entry);
        return {
          update(patch) {
            contribution.button = { ...contribution.button, ...patch };
          },
          remove() {
            entry.removed = true;
          },
        };
      },
    },
  };
}

const live = (fake) => fake.pills.filter((entry) => !entry.removed);

/**
 * A Paseo 0.9 client: `agents.subscribe()` alone hears nothing there, and the
 * agent feed comes from an observation opened with `list({ subscribe: {} })`.
 * The observation hands a new subscriber its current snapshot, as Paseo does,
 * and hands a fresh one again after a reconnect.
 */
function createObservingClient({ agents, items, pillMode, queueDelayMs = 0, listDelayMs = 0 }) {
  const pills = [];
  const lists = [];
  let observer = null;
  let released = 0;
  let detached = 0;
  let listened = false;
  const snapshotOf = (list) => ({
    requestId: "req",
    subscriptionId: "sub",
    entries: list.map((agent) => ({ agent })),
    pageInfo: { hasMore: false, nextCursor: null },
  });
  return {
    pills,
    lists,
    get released() {
      return released;
    },
    get listened() {
      return listened;
    },
    get detached() {
      return detached;
    },
    reconnect(list) {
      observer?.snapshot(snapshotOf(list));
    },
    update(payload) {
      observer?.update({ type: "agent_update", payload });
    },
    fail(error) {
      const current = observer;
      observer = null;
      current?.error?.(error);
    },
    client: {
      paseo: {
        observeEvents() {},
        agents: {
          subscribe() {
            listened = true;
            return () => undefined;
          },
          async list(options) {
            lists.push(options);
            if (!options?.subscribe) throw new Error("an observing client made a plain agent read");
            // Intentionally ignore the abort signal here. A compatibility
            // layer or an already-completing request can still resolve after
            // teardown, and that late observation must be released.
            if (listDelayMs > 0) await new Promise((r) => globalThis.setTimeout(r, listDelayMs));
            return {
              ...snapshotOf(agents()),
              subscription: {
                subscribe(next) {
                  observer = next;
                  next.snapshot(snapshotOf(agents()));
                  return () => {
                    detached += 1;
                    if (observer === next) observer = null;
                  };
                },
                async release() {
                  released += 1;
                  observer = null;
                },
              },
            };
          },
        },
      },
      async rpc(contract) {
        if (contract.name !== "defer.list") throw new Error(`unexpected rpc ${contract.name}`);
        if (queueDelayMs > 0) await new Promise((r) => globalThis.setTimeout(r, queueDelayMs));
        return { items: items(), sessionResetsAt: null, usageError: null, settings: { pillMode: pillMode() } };
      },
      openSurface() {},
      openPanel() {},
      addComposerPill(contribution) {
        const entry = { contribution, removed: false };
        pills.push(entry);
        return {
          update(patch) {
            contribution.button = { ...contribution.button, ...patch };
          },
          remove() {
            entry.removed = true;
          },
        };
      },
    },
  };
}

/** How long the entrypoint waits before reopening a failed observation, first time round. */
const REOPEN_MS = 2_000;

async function checkObservingClient() {
  const graph = await loadClientGraph();
  const ids = (fake) =>
    live(fake)
      .map((entry) => `${entry.contribution.agentId}@${entry.contribution.workspaceId}`)
      .sort()
      .join(",");

  let agents = [
    { id: "agent-1", workspaceId: "ws-1", status: "idle" },
    { id: "agent-2", workspaceId: "ws-2", status: "idle" },
  ];
  const fake = createObservingClient({ agents: () => agents, items: () => [], pillMode: () => "always" });
  const cleanup = graph.contributeClient(fake.client);
  await wait(50);

  check(fake.lists.length === 1, "0.9: one observation is opened");
  check(
    fake.lists[0]?.subscribe !== undefined && fake.lists[0]?.signal instanceof AbortSignal,
    "0.9: the agent read asks for an observation and passes an abort signal",
  );
  check(!fake.listened, "0.9: no bare agents.subscribe listener, which would hear nothing");
  check(ids(fake) === "agent-1@ws-1,agent-2@ws-2", "0.9: the snapshot puts a pill on every live session");

  // A session created after load: the case that used to need a plugin reload.
  fake.update({ kind: "upsert", agent: { id: "agent-3", workspaceId: "ws-3", status: "initializing" } });
  await wait(50);
  check(ids(fake).includes("agent-3@ws-3"), "0.9: a new session gets its pill from the observation");
  const registrations = fake.pills.length;
  fake.update({ kind: "upsert", agent: { id: "agent-3", workspaceId: "ws-3", status: "running" } });
  await wait(50);
  check(fake.pills.length === registrations, "0.9: a turn in the same workspace registers nothing new");

  fake.update({ kind: "remove", agentId: "agent-2" });
  await wait(50);
  check(!ids(fake).includes("agent-2"), "0.9: a removed session loses its pill");

  // After a reconnect the snapshot replaces the view, including what it no longer lists.
  fake.reconnect([
    { id: "agent-1", workspaceId: "ws-1", status: "idle" },
    { id: "agent-4", workspaceId: "ws-4", status: "idle" },
  ]);
  await wait(50);
  check(ids(fake) === "agent-1@ws-1,agent-4@ws-4", "0.9: a reconnect snapshot rebuilds the pill set");

  // Paseo releases an observation whose re-request fails; it has to come back.
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    agents = [{ id: "agent-5", workspaceId: "ws-5", status: "idle" }];
    fake.fail(new Error("reconnect request failed"));
    await wait(REOPEN_MS + 200);
  } finally {
    console.warn = warn;
  }
  check(
    warnings.some((line) => line.includes("agent observation failed")),
    "0.9: a failed observation is reported",
  );
  check(fake.lists.length === 2, "0.9: a failed observation is reopened");
  check(ids(fake) === "agent-5@ws-5", "0.9: the reopened observation's snapshot is applied");

  await cleanup();
  check(live(fake).length === 0, "0.9: cleanup removes every pill");
  check(fake.lists.every((options) => options.signal.aborted), "0.9: cleanup aborts the observation");
  check(fake.detached === 2, "0.9: failure and cleanup detach both local observation listeners");
  check(fake.released >= 1, "0.9: cleanup releases the observation");
  check(timers.live.size === 0, "0.9: cleanup releases every timer");
  const afterTeardown = fake.pills.length;
  fake.update({ kind: "upsert", agent: { id: "agent-6", workspaceId: "ws-6", status: "idle" } });
  await wait(50);
  check(fake.pills.length === afterTeardown, "0.9: an update after cleanup registers nothing");

  // Waiting-only mode: the snapshot can beat the first queue read, and must not
  // flash a button pill on every session while that read is in flight.
  const quiet = createObservingClient({
    agents: () => [{ id: "agent-1", workspaceId: "ws-1", status: "idle" }],
    items: () => [],
    pillMode: () => "waiting",
    queueDelayMs: 100,
  });
  const stopQuiet = graph.contributeClient(quiet.client);
  await wait(20);
  quiet.update({
    kind: "upsert",
    agent: { id: "agent-2", workspaceId: "ws-2", status: "initializing" },
  });
  await wait(20);
  check(
    quiet.pills.length === 0,
    "0.9: an agent update before the queue read cannot flash an always-mode pill",
  );
  await wait(300);
  check(quiet.pills.length === 0, "0.9: waiting-only mode never registers a pill for an empty queue");
  await stopQuiet();
  check(timers.live.size === 0, "0.9: the waiting-only entrypoint releases every timer");

  // Cleanup can win the race with the initial list request. If that request
  // still resolves, its newly-created subscription must not be orphaned.
  const late = createObservingClient({
    agents: () => [{ id: "agent-1", workspaceId: "ws-1", status: "idle" }],
    items: () => [],
    pillMode: () => "always",
    listDelayMs: 100,
  });
  const stopLate = graph.contributeClient(late.client);
  await wait(20);
  await stopLate();
  await wait(150);
  check(late.released === 1, "0.9: an observation resolving after cleanup is released");
  check(timers.live.size === 0, "0.9: late-observation cleanup leaves no timer behind");
}

/** Stands in for the app's own draft store, which a press reads on the way out. */
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

/** The window in which a press inside the card is ignored by the pill. */
const CARD_ECHO_MS = 450;

const timers = installTimerTracker();
/** Real timers, so waiting for the entrypoint's debounce is not self-referential. */
const wait = (ms) => new Promise((r) => timers.real.setTimeout(r, ms));

try {
  const graph = await loadClientGraph();

  // Label text: one message says when it lands, several say how many.
  check(graph.pillLabel([]) === "", "an empty queue has no label");
  check(
    graph.pillLabel([deferred("a", "agent-1", 900_000)]).startsWith("in "),
    "one waiting message labels its due time",
  );
  check(
    graph.pillLabel([deferred("a", "agent-1", 1), deferred("b", "agent-1", 2)]) === "2 deferred",
    "several waiting messages label the count",
  );

  let items = [];
  let agents = [{ id: "agent-1", workspaceId: "ws-1", status: "idle" }];
  let pillMode = "always";
  const fake = createFakeClient({
    items: () => items,
    agents: () => agents,
    pillMode: () => pillMode,
  });

  const cleanup = graph.contributeClient(fake.client);
  check(typeof cleanup === "function", "the entrypoint returns a cleanup function");
  await wait(50);
  check(
    fake.lastListOptions === undefined,
    "0.8: the compatibility path performs a plain agent read",
  );
  check(!fake.observationSubscribed, "0.8: the compatibility path opens no owned observation");

  // Every live session gets a pill, queue or no queue: it is the plugin's only
  // in-session affordance, and without it Defer is command-centre-only.
  check(live(fake).length === 1, "a live session with an empty queue still gets a pill");
  const registration = live(fake)[0]?.contribution;
  check(registration?.agentId === "agent-1", "the pill is bound to the session");
  check(registration?.workspaceId === "ws-1", "the pill is bound to the session's workspace");
  check(typeof registration?.Component === "function", "the pill supplies a component");
  check(
    typeof registration?.title === "string" && registration.title.trim() !== "",
    "the pill has an accessible label",
  );
  // The `Component`/`onPress` fields above are the legacy pre-descriptor
  // contract; the live v0.8 app only ever reads `button`. Pressing the real
  // pill opens a popover anchored to it, not the panel `onPress` still does.
  check(
    registration?.button?.behavior?.kind === "popover",
    "the composer pill's button descriptor opens a popover, not the panel",
  );
  check(
    typeof registration?.button?.behavior?.Content === "function",
    "the popover behavior supplies a Content component",
  );

  const draw = () => render(registration.Component, { agentId: "agent-1", workspaceId: "ws-1" });
  check(textOf(draw()).includes("Defer"), "an idle pill reads as a Defer button");
  check(cardOf(draw()) === undefined, "an idle pill shows no card");

  // A plugin draws inside the host pill's own padding, so a hover region left
  // at its natural size answers over the label and nowhere else. Cancelling
  // that padding with an equal negative margin is what makes the whole pill
  // hoverable, and it has to leave the measured size alone.
  const root = draw().props?.style ?? {};
  check(root.alignSelf === "stretch", "the pill fills the host's pill vertically");
  check(
    root.marginHorizontal === -root.paddingHorizontal && root.paddingHorizontal > 0,
    "the host's horizontal padding is cancelled and re-added, so hovering answers to the edge",
  );
  check(
    root.marginVertical === -root.paddingVertical && root.paddingVertical > 0,
    "the same vertically, where the host pill is more than twice the label's height",
  );
  check(typeof draw().props?.onPointerEnter === "function", "the whole region takes the pointer");

  // An empty prompt box and an empty queue: the pill is a plain button.
  const handed = [];
  const stopListening = graph.onComposerDraftOffered("agent-1", (offer) => handed.push(offer.text));

  composerDraft = "";
  registration?.onPress();
  check(
    fake.opened.length === 1 &&
      fake.opened[0].id === "defer" &&
      fake.opened[0].options?.agentId === "agent-1" &&
      fake.opened[0].options?.workspaceId === "ws-1",
    "pressing an idle pill opens the panel straight away",
  );
  check(cardOf(draw()) === undefined, "pressing an idle pill opens no card");
  check(handed.length === 0, "an empty prompt box hands over nothing");

  // Something half-written changes that: the card offers to defer it outright.
  composerDraft = "half a prompt";
  registration?.onPress();
  const quick = draw();
  check(cardOf(quick) !== undefined, "a half-written prompt raises the card instead");
  check(fake.opened.length === 1, "raising the card opens no panel");
  check(textOf(quick).includes("half a prompt"), "the card shows what is in the prompt box");
  const chip = (label) =>
    [...walk(draw())].find(
      (node) => typeof node === "object" && node.props?.accessibilityLabel === label,
    );
  for (const label of ["Defer this by 15m", "Defer this by 1h", "Defer this by 3h"]) {
    check(chip(label) !== undefined, `the card offers ${label.replace("Defer this by ", "")}`);
  }

  chip("Defer this by 1h")?.props.onPress();
  await wait(50);
  check(fake.created.length === 1, "a chip queues the message without a panel");
  check(fake.created[0]?.text === "half a prompt", "it queues what is in the prompt box");
  check(fake.created[0]?.agentId === "agent-1", "it queues it for that session");
  check(
    fake.created[0]?.trigger?.kind === "after" && fake.created[0]?.trigger?.ms === 3_600_000,
    "the chip's own wait is the trigger",
  );
  check(fake.opened.length === 1, "a chip press opens no panel");
  check(cardOf(draw()) === undefined, "queueing from the card puts the card away");
  // That same click reaches Paseo's pressable under the card, which must not
  // raise the card again over the message it has just queued.
  registration?.onPress();
  check(cardOf(draw()) === undefined, "the click echoing down from a chip leaves the card away");
  // Past the echo window, so the presses below are read as presses again.
  await wait(CARD_ECHO_MS);
  check(
    toasts.shown.some((message) => message.includes("prompt box still holds it")),
    "the confirmation says the prompt box was not emptied",
  );
  check(toasts.errors.length === 0, "queueing from the card raises no error");

  // On web the chip's click also reaches the card under it, which must not then
  // open the panel the chip just made unnecessary. Same tree, same refs.
  registration?.onPress();
  const echo = draw();
  [...walk(echo)]
    .find((node) => typeof node === "object" && node.props?.accessibilityLabel === "Defer this by 15m")
    ?.props.onPress();
  cardOf(echo)?.props.onPress();
  check(fake.opened.length === 1, "the click echoing down from a chip does not open the panel");
  await wait(CARD_ECHO_MS);

  // An empty prompt box while the chip was up: nothing is queued from nothing.
  const queuedBefore = fake.created.length;
  registration?.onPress();
  const stale = draw();
  composerDraft = "";
  [...walk(stale)]
    .find((node) => typeof node === "object" && node.props?.accessibilityLabel === "Defer this by 15m")
    ?.props.onPress();
  await wait(50);
  check(fake.created.length === queuedBefore, "an emptied prompt box queues nothing");
  check(
    toasts.errors.some((message) => message.includes("nothing in the prompt box")),
    "an emptied prompt box says why nothing happened",
  );
  // The failed press echoes down like any other; put the card away after it.
  await wait(CARD_ECHO_MS);
  registration?.onPress();
  check(cardOf(draw()) === undefined, "the card closes again after all that");

  // Queue something for that session: the same pill becomes a status.
  items = [deferred("one", "agent-1", 900_000)];
  graph.notifyDeferChanged();
  await wait(400);
  check(live(fake).length === 1, "queueing a message does not add a second pill");
  check(textOf(draw()).includes("in "), "a waiting message replaces the button label");
  check(
    registration?.button?.title === "Deferred: message one",
    "the host hover tooltip shows the deferred message",
  );

  // The pill toggles the preview card; the card is what opens the panel.
  registration?.onPress();
  check(cardOf(draw()) !== undefined, "pressing the pill opens the preview card");
  check(textOf(draw()).includes("message one"), "the card shows the waiting message");
  check(fake.opened.length === 1, "pressing the pill opens no panel while something waits");

  registration?.onPress();
  check(cardOf(draw()) === undefined, "pressing the pill again closes the card");
  check(fake.opened.length === 1, "closing the card opens no panel");

  composerDraft = "and this too";
  registration?.onPress();
  cardOf(draw())?.props.onPress();
  check(
    fake.opened.length === 2 && fake.opened[1].options?.agentId === "agent-1",
    "pressing the card opens the panel for that session",
  );
  check(handed.join("|") === "and this too", "the card opens the panel with the composer draft too");
  check(cardOf(draw()) === undefined, "opening the panel puts the card away");
  stopListening();

  // On web that same click also reaches Paseo's pressable under the card.
  registration?.onPress();
  check(cardOf(draw()) === undefined, "the click echoing down to the pill does not re-open the card");

  // A second live session gets its own pill from the agent stream alone.
  const readsBefore = fake.listCalls;
  agents = [...agents, { id: "agent-2", workspaceId: "ws-2", status: "idle" }];
  fake.emitAgent(agents[1]);
  await wait(50);
  check(live(fake).length === 2, "a second live session gets its own pill");
  check(
    fake.listCalls === readsBefore,
    "an agent update carries the workspace, so no extra agent read is needed",
  );

  fake.emitAgent(agents[1]);
  await wait(50);
  check(live(fake).length === 2, "a repeated agent update registers nothing new");

  // Settling every message must leave the button behind, not remove the pill.
  items = items.map((item) => ({ ...item, state: "sent", settledAt: new Date().toISOString() }));
  graph.notifyDeferChanged();
  await wait(400);
  check(live(fake).length === 2, "an emptied queue keeps the pill as a button");
  check(textOf(draw()).includes("Defer"), "an emptied queue restores the button label");
  check(
    registration?.button?.title === "Defer a message to this session",
    "an emptied queue restores the generic hover tooltip",
  );
  check(cardOf(draw()) === undefined, "an emptied queue leaves no card behind");

  // A message for a session Paseo has no snapshot for has nowhere to sit.
  items = [deferred("three", "agent-orphan", 60_000)];
  graph.notifyDeferChanged();
  await wait(400);
  check(live(fake).length === 2, "a message for an unknown session adds no pill");

  fake.emitAgent({ id: "agent-2", workspaceId: "ws-2", status: "closed" });
  await wait(50);
  check(
    live(fake).length === 1 && live(fake)[0].contribution.agentId === "agent-1",
    "a closed session loses its pill",
  );

  fake.emitRemove("agent-1");
  await wait(50);
  check(live(fake).length === 0, "a removed session loses its pill");

  fake.emitAgent({ id: "agent-1", workspaceId: "ws-1", status: "idle" });
  await wait(50);
  check(live(fake).length === 1, "a session that comes back gets its pill again");

  fake.emitAgent({ id: "agent-1", workspaceId: "ws-9", status: "idle" });
  await wait(50);
  check(
    live(fake).length === 1 && live(fake)[0].contribution.workspaceId === "ws-9",
    "a session that moves workspace is re-registered against the new one",
  );

  // Anyone who does not want a Defer button on every composer switches the pill
  // to waiting-only: the button-only pills go, the queued ones stay.
  items = [deferred("five", "agent-1", 900_000)];
  pillMode = "waiting";
  graph.notifyDeferChanged();
  await wait(400);
  check(
    live(fake).length === 1 && live(fake)[0].contribution.agentId === "agent-1",
    "waiting-only keeps the pill where something is queued",
  );

  items = [];
  graph.notifyDeferChanged();
  await wait(400);
  check(live(fake).length === 0, "waiting-only drops the pill once the queue empties");

  pillMode = "always";
  graph.notifyDeferChanged();
  await wait(400);
  check(live(fake).length === 1, "switching back to every session restores the button pill");

  // Leave a pressed preview up: its dismissal timer must not outlive teardown.
  items = [deferred("four", "agent-1", 60_000)];
  graph.notifyDeferChanged();
  await wait(400);
  live(fake)[0]?.contribution.onPress();

  await cleanup();
  check(live(fake).length === 0, "cleanup removes every pill");
  check(fake.unsubscribed, "0.8: cleanup unsubscribes from local agent updates");
  check(!fake.observationListenerRemoved, "0.8: cleanup has no observation listener to remove");
  check(!fake.observationReleased, "0.8: cleanup has no observation to release");
  check(timers.live.size === 0, "cleanup releases every timer");

  // Nothing may reach Paseo after teardown.
  const afterTeardown = fake.pills.length;
  graph.notifyDeferChanged();
  fake.emitAgent({ id: "agent-5", workspaceId: "ws-5", status: "idle" });
  await wait(400);
  check(fake.pills.length === afterTeardown, "a notification after cleanup registers nothing");

  await checkObservingClient();
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  timers.restore();
}

console.log("Checking composer pill lifecycle...");
for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Composer pill check failed.");
  // A leaked interval would otherwise keep this process alive forever, turning
  // a reported failure into a hung check.
  process.exit(1);
}
console.log("  ✓ pill: registers per session, opens its panel, and releases everything on cleanup");
console.log("  ✓ pill (0.9 observation): follows new sessions, rebuilds on reconnect, reopens after failure");
process.exit(0);
