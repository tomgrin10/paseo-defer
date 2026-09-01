/**
 * Drives the composer-pill client entrypoint outside the app.
 *
 * `check-bundles.mjs` proves `addClientSide` is registered; this proves the
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

/** Host modules Paseo provides to client code; anything else must fail. */
const STUBS = {
  react,
  "react/jsx-runtime": jsxRuntime,
  "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
  "@tanstack/react-query": {},
  "@getpaseo/plugin": { Icon: () => null, defineRpc: (d) => d },
  "@getpaseo/plugin/react-native": { Icon: () => null, Modal: () => null, useToast: () => ({}) },
  "@getpaseo/plugin/server": { defineRpc: (d) => d, defineAttachmentSource: (d) => d },
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
const ENTRY_SOURCE = `export { contributeClient } from "./pill.client";
export { notifyDeferChanged } from "./refresh.client";
export { pillLabel } from "./format.shared";
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
  let agentHandler = null;
  let unsubscribed = false;
  let listCalls = 0;
  return {
    pills,
    opened,
    get listCalls() {
      return listCalls;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    emitAgent(agent) {
      agentHandler?.({ kind: "upsert", agent });
    },
    emitRemove(agentId) {
      agentHandler?.({ kind: "remove", agentId });
    },
    client: {
      paseo: {
        agents: {
          subscribe(handler) {
            agentHandler = handler;
            return () => {
              unsubscribed = true;
            };
          },
          async list() {
            listCalls += 1;
            return { requestId: "req", entries: agents().map((agent) => ({ agent })), pageInfo: {} };
          },
        },
      },
      async rpc(contract) {
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
        return () => {
          entry.removed = true;
        };
      },
    },
  };
}

const live = (fake) => fake.pills.filter((entry) => !entry.removed);

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

  const draw = () => render(registration.Component, { agentId: "agent-1", workspaceId: "ws-1" });
  check(textOf(draw()).includes("Defer"), "an idle pill reads as a Defer button");
  check(cardOf(draw()) === undefined, "an idle pill shows no card");

  registration?.onPress();
  check(
    fake.opened.length === 1 &&
      fake.opened[0].id === "defer" &&
      fake.opened[0].options?.agentId === "agent-1" &&
      fake.opened[0].options?.workspaceId === "ws-1",
    "pressing an idle pill opens the panel straight away",
  );
  check(cardOf(draw()) === undefined, "pressing an idle pill opens no card");

  // Queue something for that session: the same pill becomes a status.
  items = [deferred("one", "agent-1", 900_000)];
  graph.notifyDeferChanged();
  await wait(400);
  check(live(fake).length === 1, "queueing a message does not add a second pill");
  check(textOf(draw()).includes("in "), "a waiting message replaces the button label");

  // The pill toggles the preview card; the card is what opens the panel.
  registration?.onPress();
  check(cardOf(draw()) !== undefined, "pressing the pill opens the preview card");
  check(textOf(draw()).includes("message one"), "the card shows the waiting message");
  check(fake.opened.length === 1, "pressing the pill opens no panel while something waits");

  registration?.onPress();
  check(cardOf(draw()) === undefined, "pressing the pill again closes the card");
  check(fake.opened.length === 1, "closing the card opens no panel");

  registration?.onPress();
  cardOf(draw())?.props.onPress();
  check(
    fake.opened.length === 2 && fake.opened[1].options?.agentId === "agent-1",
    "pressing the card opens the panel for that session",
  );
  check(cardOf(draw()) === undefined, "opening the panel puts the card away");

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
  check(fake.unsubscribed, "cleanup unsubscribes from agent updates");
  check(timers.live.size === 0, "cleanup releases every timer");

  // Nothing may reach Paseo after teardown.
  const afterTeardown = fake.pills.length;
  graph.notifyDeferChanged();
  fake.emitAgent({ id: "agent-5", workspaceId: "ws-5", status: "idle" });
  await wait(400);
  check(fake.pills.length === afterTeardown, "a notification after cleanup registers nothing");
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
process.exit(0);
