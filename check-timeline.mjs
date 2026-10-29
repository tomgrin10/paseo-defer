import { build } from "esbuild";
import { instantiateBundle } from "./check-lib.mjs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const built = await build({ entryPoints: ["server/timeline.ts"], bundle: true, write: false, format: "cjs", platform: "node", external: ["zod"] });
const { DeferredTimeline } = instantiateBundle(built.outputFiles[0].text, require);
const directory = await mkdtemp(join(tmpdir(), "defer-timeline-check-"));
const managers = [];
function fixture(name) {
  const path = join(directory, name);
  const world = { items: [{ id: "one", agentId: "agent", text: "Review this change", trigger: { kind: "after", ms: 3600000 }, createdAt: "2026-10-11T10:00:00.000Z", dueAt: "2026-10-11T11:00:00.000Z", state: "pending" }], calls: [], beforeAppend: null, fail: false };
  const api = { agents: { ref: agentId => ({ timeline: { append: async row => {
    assert.equal(agentId, "agent");
    assert.ok(JSON.parse(await readFile(join(path, "timeline-items.json"), "utf8")).rows.some(r => `deferred:${r.id}` === row.id));
    world.calls.push(structuredClone(row));
    await world.beforeAppend?.(row);
    if (world.fail) throw new Error("private daemon details");
  } } }) } };
  const manager = () => { const m = new DeferredTimeline(path, async () => structuredClone(world.items)); managers.push(m); return m; };
  return { path, world, api, manager };
}
try {
  const f = fixture("lifecycle"); const manager = f.manager();
  await manager.use(f.api); assert.equal(manager.error, null);
  assert.equal(f.world.calls[0].kind, "deferred-message"); assert.equal(f.world.calls[0].data.text, "Review this change");
  await manager.refresh(); assert.equal(f.world.calls.length, 1, "unchanged polling must not append rows");
  f.world.items[0].text = "Edited"; f.world.items[0].dueAt = "2026-10-12T11:00:00.000Z";
  await manager.refresh(); assert.equal(f.world.calls.at(-1).data.text, "Edited"); assert.equal(f.world.calls.at(-1).data.dueAt, f.world.items[0].dueAt);
  f.world.items[0].state = "sending"; await manager.refresh(); assert.equal(f.world.calls.at(-1).data.state, "sending");
  f.world.items[0].state = "failed"; await manager.refresh(); assert.equal(f.world.calls.at(-1).data.state, "failed");
  f.world.items[0].state = "sent"; await manager.refresh(); assert.deepEqual(f.world.calls.at(-1).data, { state: "settled" });
  assert.equal(new Set(f.world.calls.map(row => row.id)).size, 1, "updates must reuse the same row");
  assert.deepEqual(JSON.parse(await readFile(join(f.path, "timeline-items.json"), "utf8")).rows, []);
  assert.equal((await stat(join(f.path, "timeline-items.json"))).mode & 0o777, 0o600);

  const reload = fixture("reload"); const first = reload.manager(); await first.use(reload.api); await first.stop();
  const second = reload.manager(); await second.use(reload.api); assert.equal(reload.world.calls.at(-1).data.state, "pending");
  reload.world.items = []; await second.refresh(); assert.deepEqual(reload.world.calls.at(-1).data, { state: "settled" });

  const lost = fixture("lost-ack"); lost.world.fail = true; const owner = lost.manager();
  const logs = []; const original = console.error; console.error = text => logs.push(text);
  try { await owner.use(lost.api); await owner.refresh(); } finally { console.error = original; }
  assert.equal(logs.length, 1); assert.ok(!logs[0].includes("private daemon details"));
  await owner.stop(); lost.world.items[0].state = "cancelled"; lost.world.fail = false;
  const recovered = lost.manager(); await recovered.use(lost.api); assert.deepEqual(lost.world.calls.at(-1).data, { state: "settled" });

  const race = fixture("cancel-during-append"); let release, started;
  const gate = new Promise(resolve => { release = resolve; }); const began = new Promise(resolve => { started = resolve; });
  let once = true; race.world.beforeAppend = async () => { if (once) { once = false; started(); await gate; } };
  const racing = race.manager(); const active = racing.use(race.api); await began;
  race.world.items[0].state = "cancelled"; const cancelled = racing.refresh(); release(); await Promise.all([active, cancelled]);
  assert.deepEqual(race.world.calls.map(row => row.data.state), ["pending", "settled"]);

  const isolated = fixture("one-failing-row"); isolated.world.items.push({ ...isolated.world.items[0], id: "two" });
  isolated.world.beforeAppend = row => { if (row.id === "deferred:one") throw new Error("session unavailable"); };
  const isolatedManager = isolated.manager(); await isolatedManager.use(isolated.api);
  assert.ok(isolatedManager.error); assert.ok(isolated.world.calls.some(row => row.id === "deferred:two"));
  isolated.world.beforeAppend = null; await isolatedManager.refresh(); assert.equal(isolatedManager.error, null);
  assert.equal(isolated.world.calls.filter(row => row.id === "deferred:two").length, 1);

  const stopping = fixture("stop-during-append"); let finish, entered;
  const blocked = new Promise(resolve => { finish = resolve; }); const entering = new Promise(resolve => { entered = resolve; });
  stopping.world.beforeAppend = async () => { entered(); await blocked; };
  const stoppedManager = stopping.manager(); const inFlight = stoppedManager.use(stopping.api); await entering;
  let drained = false; const drain = stoppedManager.stop().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); finish(); await Promise.all([inFlight, drain]); assert.equal(drained, true);

  const large = fixture("large"); large.world.items[0].text = "\u0000🕒".repeat(100000);
  await large.manager().use(large.api); assert.ok(Buffer.byteLength(JSON.stringify(large.world.calls[0].data)) < 65536);

  const visibility = fixture("visible"); visibility.world.items.push({ ...visibility.world.items[0], id: "old-failure", state: "failed" });
  const visibleManager = visibility.manager(); assert.deepEqual((await visibleManager.visibleItems()).map(item => item.id), ["one"]);
  await visibleManager.use(visibility.api); visibility.world.items[0].state = "failed"; assert.deepEqual((await visibleManager.visibleItems()).map(item => item.id), ["one"]);
  visibility.world.items[0].state = "sent"; assert.deepEqual(await visibleManager.visibleItems(), []);

  const clientBuild = await build({ entryPoints: ["client/timeline.tsx"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/client", "./composer", "./refresh", "zod"] });
  const slots = []; let cursor = 0; let queue = { items: [], sessionResetsAt: null, usageError: null }; let deleteResult = { ok: true, error: null }; let failure = null; let calls = []; let updateResult = { item: f.world.items[0], error: null }; let updateGate; const toasts = [];
  const ui = instantiateBundle(clientBuild.outputFiles[0].text, id => {
    if (id === "zod") return require(id);
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react-native") return { Text: "Text", View: "View", Pressable: "Pressable" };
    if (id === "@getpaseo/plugin/client/react-native") return { Icon: "Icon", useToast: () => ({ show: text => toasts.push(text), error: text => toasts.push(text) }) };
    if (id === "react") return { useRef: value => { const index = cursor++; return slots[index] ??= { current: value }; }, useState: value => { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], value => { slots[index] = value; }]; } };
    if (id === "@getpaseo/plugin/client") return { useRpc: contract => async input => { calls.push({ name: contract.name, input }); if (failure) throw new Error(failure); if (contract.name === "defer.update") { await updateGate; return updateResult; } return contract.name === "defer.list" ? queue : deleteResult; } };
    if (id === "./composer") return { DeferComposer: "Composer", deferStyles: () => ({}) };
    if (id === "./refresh") return { notifyDeferChanged() {} };
    throw new Error(`Unexpected module ${id}`);
  });
  let renderer;
  ui.contributeTimeline({ addTimelineRenderer: r => { renderer = r; } });
  assert.equal(renderer.kind, "deferred-message"); assert.equal(renderer.version, 1);
  assert.equal(renderer.schema.safeParse({ state: "invalid" }).success, false);
  const render = props => { cursor = 0; return renderer.Component(props); };
  function find(tree, label) { if (!tree || typeof tree !== "object") return null; if (tree.props?.accessibilityLabel === label) return tree; for (const child of [tree.props?.children].flat(Infinity)) { const result = find(child, label); if (result) return result; } return null; }
  const item = { type: "plugin", kind: "deferred-message", version: 1, data: { state: "settled" } };
  const props = { item, theme: { colors: { foreground: "black", surface1: "white", border: "gray" } }, layout: { compact: true } };
  assert.equal(render(props), null);
  props.item = { ...item, data: f.world.calls[0].data };
  const text = JSON.stringify(render(props)); assert.ok(text.includes("Deferred message")); assert.ok(text.includes("Review this change")); assert.ok(text.includes("when the agent is idle"));
  props.item = { ...item, data: { ...f.world.calls[0].data, trigger: { kind: "sessionReset" }, dueAt: null } };
  assert.ok(JSON.stringify(render(props)).includes("Waiting for session reset"));
  props.agentId = "agent";
  props.item = { ...item, data: { ...f.world.calls[0].data, state: "pending" } };
  queue.items = [{ ...f.world.items[0], id: props.item.data.id, state: "pending", text: "full text".repeat(1000) }];
  let tree = render(props); await find(tree, "Edit deferred message").props.onPress(); await new Promise(resolve => setImmediate(resolve)); tree = render(props);
  const composer = tree.props.children.find(child => child?.type === "Composer"); assert.equal(composer.props.editing.text, queue.items[0].text); composer.props.onEditingChange(null);
  failure = "Connection lost"; tree = render(props); find(tree, "Delete deferred message").props.onPress(); await new Promise(resolve => setImmediate(resolve)); assert.ok(JSON.stringify(render(props)).includes("Connection lost"));
  failure = null; deleteResult = { ok: false, error: "Already sending" }; find(render(props), "Delete deferred message").props.onPress(); await new Promise(resolve => setImmediate(resolve)); assert.ok(JSON.stringify(render(props)).includes("Already sending"));
  deleteResult = { ok: true, error: null }; find(render(props), "Delete deferred message").props.onPress(); await new Promise(resolve => setImmediate(resolve)); assert.ok(!JSON.stringify(render(props)).includes("Already sending")); assert.deepEqual(calls.at(-1), { name: "defer.delete", input: { id: props.item.data.id } });
  props.item = { ...item, data: { ...f.world.calls[0].data, state: "pending" } };
  let releaseUpdate;
  updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  const sendButton = find(render(props), "Send deferred message now");
  const beforeSend = calls.length; const startedAt = Date.now();
  sendButton.props.onPress(); sendButton.props.onPress();
  assert.equal(calls.length, beforeSend + 1, "rapid clicks must make only one update");
  tree = render(props);
  for (const label of ["Send deferred message now", "Edit deferred message", "Delete deferred message"]) assert.equal(find(tree, label).props.disabled, true);
  assert.ok(JSON.stringify(tree).includes("Scheduling…"));
  releaseUpdate(); await new Promise(resolve => setImmediate(resolve)); updateGate = undefined;
  const sent = calls.at(-1); assert.equal(sent.name, "defer.update");
  assert.deepEqual(Object.keys(sent.input).sort(), ["id", "trigger"]);
  assert.equal(sent.input.id, props.item.data.id); assert.equal(sent.input.trigger.kind, "at");
  assert.ok(Date.parse(sent.input.trigger.iso) >= startedAt && Date.parse(sent.input.trigger.iso) <= Date.now());
  assert.ok(toasts.at(-1).includes("when the session is idle"));
  assert.equal(find(render(props), "Send deferred message now").props.disabled, false);
  updateResult = { item: null, error: "Already sending" };
  find(render(props), "Send deferred message now").props.onPress(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(JSON.stringify(render(props)).includes("Already sending"));
  failure = "Connection lost";
  find(render(props), "Send deferred message now").props.onPress(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(JSON.stringify(render(props)).includes("Connection lost")); failure = null;
  updateResult = { item: f.world.items[0], error: null };
  find(render(props), "Send deferred message now").props.onPress(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!JSON.stringify(render(props)).includes("Connection lost"));
  props.item.data.state = "sending"; assert.equal(find(render(props), "Send deferred message now"), null); assert.equal(find(render(props), "Delete deferred message"), null); assert.equal(find(render(props), "Edit deferred message"), null);
  const footerBuild = await build({ entryPoints: ["client/timeline-footer.tsx"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/plugin/client", "@tanstack/react-query", "./timeline", "./refresh", "zod"] });
  let footerQueue = { data: { items: [] }, error: null, refetch: () => {} }; let refreshes = 0;
  const footerUI = instantiateBundle(footerBuild.outputFiles[0].text, id => {
    if (id === "zod") return require(id);
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react-native") return { Text: "Text", View: "View", Pressable: "Pressable" };
    if (id === "react") return { useEffect: () => {} };
    if (id === "@getpaseo/plugin/client") return { useRpc: () => async () => ({ items: [] }) };
    if (id === "@tanstack/react-query") return { useQuery: () => footerQueue };
    if (id === "./timeline") return { DeferredMessage: "DeferredMessage" };
    if (id === "./refresh") return { onDeferChanged: () => () => {} };
    throw new Error(`Unexpected module ${id}`);
  });
  footerUI.contributePinnedTimeline({}); let footerContribution;
  footerUI.contributePinnedTimeline({ addTimelineFooter: value => { footerContribution = value; } });
  assert.deepEqual(footerContribution.replaces, [{ kind: "deferred-message", version: 1 }]);
  const footerProps = { ...props, host: { id: "host" } };
  assert.equal(footerContribution.Component(footerProps), null);
  footerQueue.data.items = [{ ...visibility.world.items[0], state: "pending", text: "x".repeat(10000) }];
  const card = footerContribution.Component(footerProps).props.children[0][0]; assert.ok(card.props.item.data.text.length <= 2001);
  footerQueue.error = new Error("Disconnected"); footerQueue.refetch = () => { refreshes++; };
  const failedFooter = footerContribution.Component(footerProps); assert.ok(JSON.stringify(failedFooter).includes("Could not refresh deferred messages")); find(failedFooter, "Retry deferred messages").props.onPress(); assert.equal(refreshes, 1);

  await manager.stop(); const count = f.world.calls.length; await manager.refresh(); assert.equal(f.world.calls.length, count);
  console.log("  ✓ deferred timeline: stable rows, edits, sending/failure visibility, sent/cancel cleanup, restart and lost-ack recovery, bounded previews, renderer and invisible settled rows");
} finally { await Promise.all(managers.map(m => m.stop())); await rm(directory, { recursive: true, force: true }); }
