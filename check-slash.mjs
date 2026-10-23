/**
 * Drives the `/defer` slash command against a host new enough to offer it.
 *
 * Two things need proving that nothing else can see. The first is the
 * feature detection: the contribution is newer than the minimum supported
 * Paseo, so `check-bundles.mjs` models a host without it and never reaches this
 * code at all. The second is what the command does with a line — the reading of
 * `2h ship it` is the whole interface, and the one outcome that must never
 * happen is a message queued for a time the user did not write.
 */
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOptions, instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, "index.client.tsx");

/** Reaches the client's own modules alongside `contribute`, in one graph. */
const EXTRA_EXPORTS = `
export { clientBridge } from "./shared/bridge";
export { onComposerDraftOffered } from "./client/handoff";
`;

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(description);
}

const noop = () => undefined;
const stubs = {
  react: { useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }), useState: (v) => [v, noop], useEffect: noop, useSyncExternalStore: (_s, get) => get(), createElement: noop },
  "react/jsx-runtime": { Fragment: "Fragment", jsx: noop, jsxs: noop },
  "react-native": { View: "View", Text: "Text", Pressable: "Pressable", TextInput: "TextInput", ScrollView: "ScrollView" },
  "@tanstack/react-query": { useQuery: noop, useMutation: noop, useQueryClient: noop },
  "@getpaseo/plugin/client/ui": { SettingsAction: () => null, SettingsCard: () => null, SettingsSection: () => null, SettingsSwitch: () => null },
  "@getpaseo/plugin": { defineSettings: (d) => d, settingsRpc: (id) => ({ read: { name: `settings.${id}.read` } }), defineRpc: (d) => d },
  "@getpaseo/plugin/client": { useRpc: noop, useAgent: noop, useWorkspace: noop },
  "@getpaseo/plugin/client/react-native": { Icon: noop, Modal: noop, useToast: noop },
};

async function loadClientGraph() {
  const source = readFileSync(ENTRY, "utf8");
  const built = await esbuild.build(buildOptions(ENTRY, DIR, `${source}${EXTRA_EXPORTS}`, "client"));
  const zod = await import("zod");
  return instantiateBundle(built.outputFiles[0].text, (id) => {
    if (id === "zod") return zod;
    if (!(id in stubs)) throw new Error(`Module "${id}" is not available in plugin client code`);
    return stubs[id];
  });
}

/** A host that offers the contribution, and one that predates it. */
function fakePlugin() {
  const registered = [];
  const plugin = {
    handle: noop,
    addSettingsScreen: () => noop,
    addSurface: () => noop,
    addSidebarItem: noop,
    addWorkspacePanel: noop,
    addCommandCenterItem: () => noop,
    addSlashCommand: (contribution) => registered.push(contribution),
    addComposerPill: () => noop,
    addAttachmentSource: noop,
    addTheme: noop,
    addTimelineTransformer: noop,
    addTimelineRenderer: noop,
    paseo: {
      agents: { list: async () => ({ entries: [] }), subscribe: () => noop },
    },
    rpc: async () => ({ items: [], settings: { pillMode: "always" } }),
    openPanel: noop,
  };
  return { plugin, registered };
}

/** Records what the command asks the host to do while running one line. */
function run(command, args) {
  const calls = [];
  const opened = [];
  return command
    .onSubmit({
      context: "agent",
      agent: { id: "agent-1" },
      args,
      async rpc(contract, input) {
        calls.push({ name: contract.name, input });
        return { item: { ...input, id: "queued", dueAt: null, state: "pending" } };
      },
      openPanel: (id) => opened.push(id),
      openSurface: noop,
      paseo: {},
    })
    .then(() => ({ calls, opened }));
}

try {
  const graph = await loadClientGraph();

  const host = fakePlugin();
  const cleanup = graph.default(host.plugin);
  check(host.registered.length === 1, "a host that offers it gets the command");
  const command = host.registered[0] ?? {};
  check(command.name === "defer", "it is /defer");
  check(command.context === "agent", "it belongs to a session");
  check(
    typeof command.description === "string" && command.description.trim() !== "",
    "it says what it does",
  );
  check(
    typeof command.argumentHint === "string" && command.argumentHint.trim() !== "",
    "it shows how the line is written",
  );

  // --- A line that says when ---
  const wait = await run(command, "2h ship the release notes");
  const queued = wait.calls[0];
  check(queued?.name === "defer.create", "a complete line queues the message itself");
  check(queued?.input.text === "ship the release notes", "the message is what follows the time");
  check(
    queued?.input.trigger.kind === "after" && queued.input.trigger.ms === 7_200_000,
    "the wait at the front is the trigger",
  );
  check(queued?.input.agentId === "agent-1", "it is queued for the session it was typed in");
  check(wait.opened.length === 0, "a complete line opens no panel");

  const clock = await run(command, "at 9:30 pm ship it");
  check(clock.calls[0]?.input.trigger.kind === "at", "a clock time is queued as an instant");
  check(clock.calls[0]?.input.text === "ship it", "the message survives a three-word time");

  const reset = await run(command, "reset take another look");
  check(
    reset.calls[0]?.input.trigger.kind === "sessionReset" &&
      reset.calls[0]?.input.text === "take another look",
    "the usage window can be named in words",
  );

  // --- Lines that leave something out, which are finished in the panel ---
  const offered = [];
  const stop = graph.onComposerDraftOffered("agent-1", (offer) => offered.push(offer));

  const untimed = await run(command, "ship it at some point");
  check(untimed.calls.length === 0, "a line with no time queues nothing");
  check(untimed.opened.join() === "defer", "it opens the panel instead");
  check(offered[0]?.text === "ship it at some point", "the whole line carries over to the panel");
  check(offered[0]?.trigger === null, "with no timing invented for it");

  const timeOnly = await run(command, "15m");
  check(timeOnly.calls.length === 0, "a time with no message queues nothing");
  check(timeOnly.opened.join() === "defer", "it opens the panel too");
  check(
    offered[1]?.trigger?.ms === 900_000 && offered[1]?.text === "",
    "the timing that was written carries over",
  );

  const bare = await run(command, "");
  check(bare.calls.length === 0 && bare.opened.join() === "defer", "/defer on its own opens Defer");
  check(offered.length === 2, "an empty line offers nothing to carry");
  stop();

  check(typeof graph.clientBridge.offer === "function", "the shared body can reach the hand-over");
  check(typeof graph.clientBridge.changed === "function", "and the refresh notifier");

  await cleanup();
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Slash command check failed.");
  process.exit(1);
}
console.log("  ✓ /defer: reads the line it was given, and never invents a delivery time");
process.exit(0);
