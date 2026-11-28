/**
 * The Paseo 0.17.1 workspace-row badge: each sidebar workspace row names the
 * messages waiting for its sessions, from the queue the pill's poll already
 * reads and the agent stream the pill already follows.
 *
 * What only this check sees:
 * - registered only on a host with both `addWorkspaceRowBadgeItem` and the
 *   `WorkspaceRowBadge` component; an older host gets nothing and no error;
 * - a row shows the pill's own words ("2 · …") for every waiting message of
 *   every session in that workspace, closed sessions included, and draws
 *   nothing for a workspace with none;
 * - a session that moves workspace or is removed takes its messages along;
 * - no extra agent list, poll or per-agent read: the badge never wakes a
 *   dormant agent to learn where it lives;
 * - cleanup removes the badge.
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

const react = {
  useCallback: (fn) => fn,
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
};

const BADGE = function HostWorkspaceRowBadge() { return null; };

function stubs({ badge = true } = {}) {
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
    "@getpaseo/plugin/client": {},
    "@getpaseo/plugin/client/ui": {
      Icon: () => null,
      Modal: Object.assign(() => null, { Content: () => null }),
      TextInput: () => null,
      ScrollView: () => null,
      useToast: () => ({ show() {}, error() {} }),
      ...(badge ? { WorkspaceRowBadge: BADGE } : {}),
    },
  };
}

const ENTRY = resolve(DIR, ".check-row-badge.entry.ts");
async function loadGraph(options) {
  writeFileSync(
    ENTRY,
    [
      `export { contributeClient } from "./client/pill";`,
      `export { contributeRowBadge, ROW_BADGE_ID, ROW_BADGE_TITLE } from "./client/row-badge";`,
      `export { createLiveQueue } from "./client/live";`,
      `export { pillLabel, deferredTitle } from "./shared/format";`,
      ``,
    ].join("\n"),
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

/** A 0.17 host: observed agents, composer pills, workspace-row badges. */
function createHost({ agents, items, withBadges = true }) {
  const host = { badges: [], removedBadges: 0, lists: 0, refs: 0, observer: null };
  const snapshotOf = (list) => ({ entries: list.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } });
  host.client = {
    paseo: {
      observeEvents() {},
      agents: {
        subscribe: () => () => undefined,
        async list() {
          host.lists += 1;
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
        ref() {
          host.refs += 1;
          return { async setMetadata() {} };
        },
      },
    },
    async rpc(contract) {
      if (contract.name !== "defer.list") throw new Error(`unexpected rpc ${contract.name}`);
      return { items: items(), sessionResetsAt: null, usageError: null, settings: { pillMode: "always" } };
    },
    openScreen() {},
    openPanel() {},
    addComposerPill() {
      return { update() {}, remove() {} };
    },
    ...(withBadges
      ? {
          addWorkspaceRowBadgeItem(contribution) {
            host.badges.push(contribution);
            return () => {
              host.removedBadges += 1;
            };
          },
        }
      : {}),
  };
  return host;
}

/** Renders the badge item for a workspace down to the host badge's props, or null. */
function badgeFor(Item, workspaceId) {
  const tree = Item({ workspaceId, theme: {}, host: { id: "host", label: "Host" }, layout: { compact: false, platform: "web" } });
  if (tree === null) return null;
  const inner = typeof tree.type === "function" ? tree.type(tree.props) : tree;
  return inner?.type === BADGE ? inner.props : { unexpected: inner };
}

try {
  const graph = await loadGraph();
  const agents = [
    { id: "agent-1", workspaceId: "ws-1", status: "idle", metadata: {} },
    { id: "agent-2", workspaceId: "ws-1", status: "running", metadata: {} },
    { id: "agent-3", workspaceId: "ws-2", status: "closed", metadata: {} },
    { id: "agent-4", workspaceId: "ws-3", status: "idle", metadata: {} },
  ];
  let queue = [
    deferred("d1", "agent-1", 3 * 3_600_000),
    deferred("d2", "agent-2", 12 * 60_000),
    deferred("d3", "agent-3", 5 * 3_600_000),
  ];
  const host = createHost({ agents: () => agents, items: () => queue });
  const live = graph.createLiveQueue();
  const stopBadge = graph.contributeRowBadge(host.client, live);
  const stopPill = graph.contributeClient(host.client, live);
  await wait(50);

  check(host.badges.length === 1, `0.17: one workspace-row badge item is registered (got ${host.badges.length})`);
  const item = host.badges[0] ?? {};
  check(item.id === graph.ROW_BADGE_ID && item.title === graph.ROW_BADGE_TITLE, "the badge is listed in the Show menu by its title");
  check(typeof item.icon === "string" && item.icon !== "", "the Show menu entry has an icon");
  const Item = item.Component ?? (() => null);

  const ws1 = badgeFor(Item, "ws-1");
  const ws1Items = queue.filter((d) => d.agentId === "agent-1" || d.agentId === "agent-2");
  check(ws1?.label === graph.pillLabel(ws1Items), `a workspace with two sessions waiting reads like the pill (got ${JSON.stringify(ws1)})`);
  check(/^2 · in 1[12]m$/.test(ws1?.label ?? ""), `two waiting, the next inside the hour: "2 · in 12m" (got ${ws1?.label})`);
  check(ws1?.tone === "muted", "the badge is muted");
  check(ws1?.icon === "Clock", "the badge carries the clock icon");
  check(ws1?.accessibilityLabel === graph.deferredTitle(ws1Items), "the badge is announced with the pill's summary");

  const ws2 = badgeFor(Item, "ws-2");
  check(ws2?.label === graph.pillLabel([queue[2]]), `a closed session's message still shows on its workspace (got ${JSON.stringify(ws2)})`);
  check(badgeFor(Item, "ws-3") === null, "a workspace with nothing waiting draws nothing");
  check(badgeFor(Item, "ws-unknown") === null, "an unknown workspace draws nothing");

  // A session moves workspace: its message moves with it.
  host.observer.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agents[1], workspaceId: "ws-3" } } });
  check(badgeFor(Item, "ws-1")?.label === graph.pillLabel([queue[0]]), "after a move the old workspace keeps only its own messages");
  check(badgeFor(Item, "ws-3")?.label === graph.pillLabel([queue[1]]), "after a move the new workspace shows the moved message");

  // A session is removed: its message leaves every row.
  host.observer.update({ type: "agent_update", payload: { kind: "remove", agentId: "agent-3" } });
  check(badgeFor(Item, "ws-2") === null, "a removed session's message leaves its workspace row");

  // A message is cancelled: the next poll clears the row.
  queue = queue.filter((d) => d.id !== "d1");
  live.publish(queue);
  check(badgeFor(Item, "ws-1") === null, "once nothing waits, the row draws nothing");

  check(host.lists === 1, `no extra agent list: the badge reuses the pill's observation (lists ${host.lists})`);

  stopPill();
  stopBadge();
  check(host.removedBadges === 1, "cleanup removes the badge");

  // Older hosts: no API, or the API without the component.
  for (const [label, options, withBadges] of [
    ["a host without addWorkspaceRowBadgeItem", {}, false],
    ["a host without the WorkspaceRowBadge component", { badge: false }, true],
  ]) {
    const old = await loadGraph(options);
    const oldHost = createHost({ agents: () => agents, items: () => queue, withBadges });
    let threw = null;
    try {
      old.contributeRowBadge(oldHost.client, old.createLiveQueue())();
    } catch (error) {
      threw = error;
    }
    check(threw === null, `${label}: registering and cleaning up does not throw (${threw})`);
    check(oldHost.badges.length === 0, `${label}: no badge is registered`);
  }
} catch (error) {
  failures.push(`check crashed: ${error?.stack ?? error}`);
}

if (failures.length > 0) {
  console.error(`check-row-badge: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("check-row-badge: ok");
