/**
 * The Paseo 0.16 composer control: Defer draws itself inside the composer
 * toolbar (`addComposerItem` + the host's `Action`) instead of registering a
 * pill per session.
 *
 * What only this check sees:
 * - the entrypoint picks the item on a host that has all three of
 *   `addComposerItem`, `useComposer` and `Action`, and pills otherwise;
 * - a composer is not told its agent, so every live session gets its own id
 *   written to its metadata, once, and never when it already carries it;
 * - the item draws nothing in a draft, on New workspace, or for an untagged
 *   agent, and honours `pillMode`;
 * - a phone (Paseo's own compact rule: below 600px, followed live through
 *   `matchMedia("(min-width: 600px)")`, or `Dimensions` on native) keeps the
 *   pills and the item draws nothing, so Defer never lands in the composer's
 *   overflow sheet and never shows twice, across any number of resizes;
 * - the saved mode is in place when the queue read is announced. The item only
 *   re-reads on that announcement, so marking the queue read after it left an
 *   "Every session" control hidden until the next poll (found in the 0.16
 *   harness).
 */
import * as esbuild from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (condition, description) => {
  if (!condition) failures.push(description);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Store subscriptions the rendered item made, so a test can replay an announcement. */
let subscriptions = [];
const react = {
  useCallback: (fn) => fn,
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useEffect: () => undefined,
  useSyncExternalStore: (subscribe, getSnapshot) => {
    subscriptions.push(subscribe);
    return getSnapshot();
  },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
};

function* walk(node) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== "object") return;
  yield node;
  yield* walk(node.props?.children);
}

const ACTION = function HostAction() { return null; };
/** The composer the item is rendered in; each test sets it. */
let composer = { context: "agent", agent: { metadata: {} } };

function stubs({ composerApi = true, dimensions } = {}) {
  return {
    react,
    "react/jsx-runtime": {
      Fragment: "Fragment",
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", ...(dimensions ? { Dimensions: dimensions } : {}) },
    "@tanstack/react-query": {},
    "@getpaseo/plugin": { defineRpc: (d) => d },
    "@getpaseo/plugin/client": composerApi ? { useComposer: () => composer } : {},
    "@getpaseo/plugin/client/ui": {
      Icon: () => null,
      Modal: Object.assign(() => null, { Content: () => null }),
      TextInput: () => null,
      ScrollView: () => null,
      useToast: () => ({ show() {}, error() {} }),
      ...(composerApi ? { Action: ACTION } : {}),
    },
  };
}

const ENTRY = resolve(DIR, ".check-composer-item.entry.ts");
async function loadGraph(options) {
  writeFileSync(
    ENTRY,
    `export { contributeClient } from "./client/pill";\nexport { AGENT_TAG, itemTitle } from "./client/composer-item";\n`,
  );
  try {
    const modules = stubs(options);
    const built = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      external: [...Object.keys(modules), "zod"],
      absWorkingDir: DIR,
      logLevel: "silent",
    });
    const zod = await import("zod");
    return instantiateBundle(built.outputFiles[0].text, (id) => {
      if (id === "zod") return zod;
      if (!(id in modules)) throw new Error(`Module "${id}" is not available in plugin client code`);
      return modules[id];
    });
  } finally {
    rmSync(ENTRY, { force: true });
  }
}

function deferred(id, agentId, dueInMs) {
  const now = Date.now();
  return {
    id,
    agentId,
    text: `message ${id}`,
    trigger: { kind: "after", ms: dueInMs },
    dueAt: new Date(now + dueInMs).toISOString(),
    anchorResetsAt: null,
    createdAt: new Date(now).toISOString(),
    state: "pending",
    settledAt: null,
    error: null,
  };
}

/** A 0.16 host: observed agents, metadata writes, composer items. */
function createHost({ agents, items, pillMode, withItems = true }) {
  const host = { pills: [], items: [], removedItems: 0, writes: [], observer: null };
  /** Pills registered and not removed since. */
  host.livePills = () => host.pills.filter((pill) => !pill.removed);
  const snapshotOf = (list) => ({ entries: list.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } });
  host.client = {
    paseo: {
      observeEvents() {},
      agents: {
        subscribe: () => () => undefined,
        async list() {
          return {
            ...snapshotOf(agents()),
            subscription: {
              subscribe(next) {
                host.observer = next;
                next.snapshot(snapshotOf(agents()));
                return () => undefined;
              },
              async release() {},
            },
          };
        },
        ref(id) {
          return {
            async setMetadata(patch) {
              host.writes.push({ id, patch });
            },
          };
        },
      },
    },
    async rpc(contract) {
      if (contract.name !== "defer.list") throw new Error(`unexpected rpc ${contract.name}`);
      return { items: items(), sessionResetsAt: null, usageError: null, settings: { pillMode: pillMode() } };
    },
    openScreen() {},
    openPanel() {},
    addComposerPill(contribution) {
      const entry = { ...contribution, removed: false };
      host.pills.push(entry);
      return {
        update() {},
        remove() {
          entry.removed = true;
        },
      };
    },
    ...(withItems
      ? {
          addComposerItem(contribution) {
            host.items.push(contribution);
            return () => {
              host.removedItems += 1;
            };
          },
        }
      : {}),
  };
  return host;
}

const HOST_PROPS = {
  theme: { colors: { foreground: "#fff", foregroundMuted: "#aaa", border: "#333", surface1: "#111", surface2: "#222" } },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "web" },
};
const actionOf = (tree) => [...walk(tree)].find((node) => node.type === ACTION);

try {
  const graph = await loadGraph();
  const TAG = graph.AGENT_TAG;
  const mode = "always";
  let queue = [deferred("d1", "agent-1", 47 * 60_000), deferred("d2", "agent-1", 3 * 3_600_000)];
  const agents = [
    { id: "agent-1", workspaceId: "ws-1", status: "idle", metadata: {} },
    { id: "agent-2", workspaceId: "ws-1", status: "idle", metadata: { [TAG]: "agent-2", other: true } },
    { id: "agent-3", workspaceId: "ws-2", status: "closed", metadata: {} },
  ];
  const host = createHost({ agents: () => agents, items: () => queue, pillMode: () => mode });

  // Rendered while the first queue read is still on its way, so the item is
  // subscribed when that read is announced, as a mounted one would be.
  const cleanup = graph.contributeClient(host.client);
  check(host.items.length === 1 && host.items[0].id === "defer", "0.16: one composer item is registered");
  const Item = host.items[0].Component;
  composer = { context: "agent", agent: { metadata: { [TAG]: "agent-2" } } };
  subscriptions = [];
  check(Item(HOST_PROPS) === null, "before the saved mode is read, nothing is drawn (no flash for a waiting-only user)");
  const seen = [];
  for (const subscribe of subscriptions) subscribe(() => seen.push(actionOf(Item(HOST_PROPS)) !== undefined));
  await wait(50);
  check(seen.length > 0 && seen.at(-1) === true, "the announcement of the first read already draws the control of a session with nothing queued");

  check(host.pills.length === 0, "0.16: no composer pills are registered");
  const tagged = host.writes.map((w) => `${w.id}:${w.patch[TAG]}`).sort().join(",");
  check(tagged === "agent-1:agent-1", `only the live, untagged session is tagged with its own id (wrote ${tagged || "nothing"})`);
  check(host.writes.every((w) => Object.keys(w.patch).length === 1), "tagging touches no other metadata key");

  // A reconnect snapshot of the same untagged session does not write it twice.
  host.observer.snapshot({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } });
  await wait(300);
  check(host.writes.length === 1, "a session is tagged once per client, not on every snapshot");

  composer = { context: "agent", agent: { metadata: { [TAG]: "agent-1" } } };
  const busy = actionOf(Item(HOST_PROPS));
  check(busy?.props.title === graph.itemTitle(queue), "a session with a queue is titled with its count and next send");
  check(/^Defer · 2 waiting · next /.test(busy?.props.title ?? ""), `the title leads with the action and carries the queue (got ${busy?.props.title})`);
  check(typeof busy?.props.icon === "function", "the control's icon is the live glyph component");

  composer = { context: "agent", agent: { metadata: { [TAG]: "agent-2" } } };
  check(actionOf(Item(HOST_PROPS))?.props.title === "Defer a message", "an idle session's control reads Defer a message");
  composer = { context: "agent", agent: { metadata: {} } };
  check(Item(HOST_PROPS) === null, "an untagged composer draws nothing");
  composer = { context: "draft", agent: { metadata: { [TAG]: "agent-1" } } };
  check(Item(HOST_PROPS) === null, "a draft composer draws nothing");
  composer = { context: "new-workspace", agent: { metadata: { [TAG]: "agent-1" } } };
  check(Item(HOST_PROPS) === null, "the New workspace composer draws nothing");

  cleanup();
  check(host.removedItems === 1, "cleanup removes the composer item");

  // Waiting-only mode, read from the first queue read.
  const waitingHost = createHost({ agents: () => agents, items: () => queue, pillMode: () => "waiting" });
  const stop = graph.contributeClient(waitingHost.client);
  await wait(50);
  const WaitingItem = waitingHost.items[0].Component;
  composer = { context: "agent", agent: { metadata: { [TAG]: "agent-2" } } };
  check(WaitingItem(HOST_PROPS) === null, "waiting-only: a session with nothing queued has no control");
  composer = { context: "agent", agent: { metadata: { [TAG]: "agent-1" } } };
  check(actionOf(WaitingItem(HOST_PROPS)) !== undefined, "waiting-only: a session with a queue keeps its control");
  stop();

  // A host with addComposerItem but without the controls keeps the pills.
  const partial = await loadGraph({ composerApi: false });
  const oldHost = createHost({ agents: () => agents, items: () => queue, pillMode: () => "always" });
  const stopOld = partial.contributeClient(oldHost.client);
  await wait(50);
  check(oldHost.items.length === 0, "without useComposer/Action no composer item is registered");
  check(oldHost.pills.length > 0, "without useComposer/Action the pills stay");
  check(oldHost.writes.length === 0, "the pill path writes no metadata");
  stopOld();

  // ---- Phones keep the pill: the host's compact rule, followed live. ----
  const media = {
    matches: false,
    listeners: new Set(),
    addEventListener(type, listener) {
      if (type === "change") this.listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change") this.listeners.delete(listener);
    },
    resize(width) {
      const next = width >= 600;
      if (next === this.matches) return;
      this.matches = next;
      for (const listener of [...this.listeners]) listener({ matches: next });
    },
  };
  const queries = [];
  globalThis.matchMedia = (query) => {
    queries.push(query);
    return media;
  };
  try {
    const live = agents.filter((agent) => agent.status !== "closed").map((agent) => agent.id).sort().join(",");
    const livePillIds = (h) => h.livePills().map((pill) => pill.agentId).sort().join(",");
    const PHONE_PROPS = { ...HOST_PROPS, layout: { compact: true, platform: "web" } };

    media.matches = false; // 390px
    const phone = createHost({ agents: () => agents, items: () => queue, pillMode: () => "always" });
    const stopPhone = graph.contributeClient(phone.client);
    await wait(50);
    check(queries.length === 1 && queries[0] === "(min-width: 600px)", `the phone rule is the host's own breakpoint query (asked ${queries.join(" | ")})`);
    check(livePillIds(phone) === live, `phone: a pill on every live session (got ${livePillIds(phone) || "none"})`);
    check(phone.items.length === 1, "phone: the item stays registered, ready for a wider window");
    const PhoneItem = phone.items[0].Component;
    composer = { context: "agent", agent: { metadata: { [TAG]: "agent-1" } } };
    check(PhoneItem(PHONE_PROPS) === null, "phone: the item draws nothing, so the overflow sheet has no Defer row");
    check(PhoneItem(HOST_PROPS) === null, "phone by the entrypoint's rule: nothing drawn even before the host flips its own layout");
    check(phone.writes.some((w) => w.id === "agent-1"), "phone: sessions are still tagged, so widening shows the item at once");

    media.resize(1440);
    check(phone.livePills().length === 0, "phone → desktop: every pill is removed in the same tick");
    check(actionOf(PhoneItem(HOST_PROPS)) !== undefined, "phone → desktop: the toolbar control draws");
    check(actionOf(PhoneItem(PHONE_PROPS)) !== undefined, "a host-only compact signal leaves the item drawn (sheet fallback), never a session with no control");

    media.resize(390);
    check(livePillIds(phone) === live, "desktop → phone: the pills come back, one per live session");
    check(PhoneItem(HOST_PROPS) === null, "desktop → phone: the item draws nothing again");

    // Repeated crossings and same-side resizes never double-register.
    for (const width of [500, 700, 1200, 599, 600, 599, 320]) media.resize(width);
    await wait(300);
    check(livePillIds(phone) === live, `after many crossings: still exactly one pill per live session (got ${livePillIds(phone)})`);
    const registrations = phone.pills.length;
    media.resize(380);
    media.resize(420);
    check(phone.pills.length === registrations, "a resize that stays on one side registers nothing");
    check(phone.removedItems === 0, "the item is never re-registered by a resize");

    stopPhone();

    // An open dialog does not survive a trip through phone width: it would
    // otherwise pop open by itself when the window widens again.
    media.matches = true;
    const dialogHost = createHost({ agents: () => agents, items: () => queue, pillMode: () => "always" });
    const stopDialog = graph.contributeClient(dialogHost.client);
    await wait(50);
    const DialogItem = dialogHost.items[0].Component;
    composer = { context: "agent", agent: { metadata: { [TAG]: "agent-1" } } };
    const modalOpen = (tree) => [...walk(tree)].find((node) => node.props && "open" in node.props && "onOpenChange" in node.props)?.props.open;
    const plainEffect = react.useEffect;
    const plainState = react.useState;
    react.useEffect = (fn) => void fn(); // lets the item claim its dialog
    const self = Symbol("defer-item"); // one mounted item: a stable identity across renders
    react.useState = (initial) => (typeof initial === "function" && String(initial).includes("defer-item") ? [self, () => undefined] : plainState(initial));
    try {
      actionOf(DialogItem(HOST_PROPS)).props.onPress({});
      check(modalOpen(DialogItem(HOST_PROPS)) === true, "desktop: pressing the control opens its dialog");
      media.resize(390);
      media.resize(1440);
      check(modalOpen(DialogItem(HOST_PROPS)) === false, "an open dialog is closed by a trip through phone width, not reopened on widening");
    } finally {
      react.useEffect = plainEffect;
      react.useState = plainState;
    }
    stopDialog();
    media.matches = false;
    check(media.listeners.size === 0, "cleanup releases the media query listener");
    check(phone.livePills().length === 0 && phone.removedItems === 1, "cleanup removes the pills and the item");

    // Waiting-only on a phone: the pill rule, unchanged.
    const phoneWaiting = createHost({ agents: () => agents, items: () => queue, pillMode: () => "waiting" });
    const stopWaiting = graph.contributeClient(phoneWaiting.client);
    await wait(50);
    check(livePillIds(phoneWaiting) === "agent-1", `phone, waiting-only: only the session with a queue has a pill (got ${livePillIds(phoneWaiting) || "none"})`);
    stopWaiting();

    // 0.15: no item API, so the pill at every width and no media listener.
    media.matches = true;
    queries.length = 0;
    const legacy = createHost({ agents: () => agents, items: () => queue, pillMode: () => "always", withItems: false });
    const stopLegacy = graph.contributeClient(legacy.client);
    await wait(50);
    check(livePillIds(legacy) === live && legacy.items.length === 0, "0.15 at desktop width: pills only, as today");
    check(queries.length === 0 && media.listeners.size === 0, "0.15: the form factor is not even watched");
    stopLegacy();
  } finally {
    delete globalThis.matchMedia;
  }

  // The native app: no matchMedia, so the window width from Dimensions.
  const dims = {
    width: 390,
    listeners: new Set(),
    get: () => ({ width: dims.width, height: 800 }),
    addEventListener(type, listener) {
      dims.listeners.add(listener);
      return { remove: () => dims.listeners.delete(listener) };
    },
    rotate(width) {
      dims.width = width;
      for (const listener of [...dims.listeners]) listener();
    },
  };
  const nativeGraph = await loadGraph({ dimensions: dims });
  const native = createHost({ agents: () => agents, items: () => queue, pillMode: () => "always" });
  const stopNative = nativeGraph.contributeClient(native.client);
  await wait(50);
  check(native.livePills().length === 2, "native phone: the pills");
  dims.rotate(844);
  check(native.livePills().length === 0, "native, rotated to a wide window: the item instead");
  dims.rotate(390);
  check(native.livePills().length === 2, "native, rotated back: the pills again");
  stopNative();
  check(dims.listeners.size === 0, "native: cleanup releases the Dimensions listener");
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

console.log("Checking the 0.16 composer control...");
for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) process.exit(1);
console.log("  ✓ composer item: replaces the pill on 0.16 desktop, a phone keeps the pill, tags sessions once, and draws only where it belongs");
process.exit(0);
