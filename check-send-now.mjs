import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { instantiateBundle } from "./check-lib.mjs";
const require = createRequire(import.meta.url);
const item = { id: "waiting", agentId: "agent", text: "Preserve this text", state: "pending", trigger: { kind: "sessionReset" }, dueAt: null, anchorResetsAt: null, createdAt: new Date().toISOString(), settledAt: null, error: null };
const tick = () => new Promise(resolve => setImmediate(resolve));
function* walk(tree) {
  if (!tree || typeof tree !== "object") return;
  yield tree;
  for (const child of [tree.props?.children].flat(Infinity)) yield* walk(child);
}
for (const [entry, exported] of [["panel", "DeferPanel"], ["popover", "DeferPopoverContent"], ["surface", "DeferOverview"]]) {
  const built = await build({ entryPoints: [`client/${entry}.tsx`], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/plugin/client", "@getpaseo/plugin/client/react-native", "@tanstack/react-query", "./composer", "./handoff", "./refresh", "zod"] });
  const slots = []; let cursor = 0, resolveUpdate, rejectUpdate, refreshFailure = false, notifications = 0;
  const calls = [], messages = [], errors = [], invalidations = [];
  const graph = instantiateBundle(built.outputFiles[0].text, id => {
    if (id === "zod") return require(id);
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react") return {
      useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; },
      useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; },
      useEffect() {}, useMemo: fn => fn(),
    };
    if (id === "react-native") return { Text: "Text", View: "View", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput" };
    if (id === "@getpaseo/plugin/client/react-native") return { Icon: "Icon", useToast: () => ({ show: message => messages.push(message), error: message => errors.push(message) }) };
    if (id === "@getpaseo/plugin/client") return {
      useAgent: () => ({ status: "running", title: "Fixture" }), useWorkspace: () => ({ name: "Fixture" }),
      useRpc: contract => input => {
        calls.push({ name: contract.name, input });
        assert.equal(contract.name, "defer.update");
        return new Promise((resolve, reject) => { resolveUpdate = resolve; rejectUpdate = reject; });
      },
    };
    if (id === "@tanstack/react-query") return {
      useQuery: ({ queryKey }) => ({ data: queryKey.includes("sessions") ? { sessions: [] } : { items: [item], sessionResetsAt: null } }),
      useQueryClient: () => ({ invalidateQueries: async input => { invalidations.push(input); if (refreshFailure) throw Error("Offline"); } }),
    };
    if (id === "./composer") return { DeferComposer: "Composer", DeferredRow: "Row", PillSetting: "Setting", deferStyles: () => ({ tone: {} }) };
    if (id === "./handoff") return { offerComposerDraft() {} };
    if (id === "./refresh") return { notifyDeferChanged: () => { notifications++; } };
    throw Error(`Unexpected module ${id}`);
  });
  const props = { theme: { colors: {} }, layout: { compact: true }, agentId: "agent", workspaceId: "workspace", context: "agent", close() {} };
  const render = () => {
    cursor = 0;
    let tree = graph[exported](props);
    if (entry === "popover") tree = tree.type(tree.props);
    return [...walk(tree)].find(node => node.type === "Row").props;
  };
  let row = render(); assert.equal(row.scheduling, false);
  const startedAt = Date.now(); const first = row.onSendNow(item); const duplicate = row.onSendNow(item);
  assert.equal(calls.length, 1, `${entry}: synchronous double click must be locked`);
  assert.equal(render().scheduling, true);
  assert.equal(calls[0].name, "defer.update");
  assert.deepEqual(Object.keys(calls[0].input).sort(), ["id", "trigger"]);
  assert.equal(calls[0].input.id, item.id); assert.equal(calls[0].input.trigger.kind, "at");
  assert.ok(Date.parse(calls[0].input.trigger.iso) >= startedAt && Date.parse(calls[0].input.trigger.iso) <= Date.now());
  resolveUpdate({ item: { ...item, trigger: calls[0].input.trigger }, error: null }); await Promise.all([first, duplicate]);
  assert.equal(render().scheduling, false); assert.equal(notifications, 1); assert.equal(invalidations.length, 1);
  assert.match(messages.at(-1), /when the session is idle/);
  const expectedKey = entry === "popover" ? ["defer-popover", "agent"] : entry === "surface" ? ["defer", "all", null] : ["defer", "agent"];
  assert.deepEqual(invalidations[0].queryKey, expectedKey);
  for (const state of ["sending", "sent", "cancelled", "failed"]) await render().onSendNow({ ...item, state });
  assert.equal(calls.length, 1, `${entry}: settled rows cannot be scheduled`);
  const refused = render().onSendNow(item); resolveUpdate({ item: null, error: "Already sending" }); await refused;
  assert.equal(errors.at(-1), "Already sending"); assert.equal(notifications, 1); assert.equal(messages.length, 1); assert.equal(render().scheduling, false);
  const failed = render().onSendNow(item); rejectUpdate(Error("Connection lost")); await failed;
  assert.equal(errors.at(-1), "Connection lost"); assert.equal(render().scheduling, false);
  refreshFailure = true;
  const stale = render().onSendNow(item); resolveUpdate({ item, error: null }); await stale;
  assert.match(errors.at(-1), /message is scheduled, but the view could not refresh/);
  assert.equal(render().scheduling, false);
  render().onEdit(item); assert.equal(render().editing, true, `${entry}: editing state reaches the row guard`);
  await tick();
}
console.log("  ✓ Send now across panel, popover and overview: at-now updates, duplicate guard, busy state, idle-aware feedback, refresh, refusal and retry");
