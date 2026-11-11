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

function stubs({ composerApi = true } = {}) {
  return {
    react,
    "react/jsx-runtime": {
      Fragment: "Fragment",
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
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
      host.pills.push(contribution);
      return { update() {}, remove() {} };
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
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

console.log("Checking the 0.16 composer control...");
for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) process.exit(1);
console.log("  ✓ composer item: replaces the pill on 0.16, tags sessions once, and draws only where it belongs");
process.exit(0);
