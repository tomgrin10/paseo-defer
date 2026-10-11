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

  const clientBuild = await build({ entryPoints: ["client/timeline.tsx"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/plugin/client/react-native", "zod"] });
  const ui = instantiateBundle(clientBuild.outputFiles[0].text, id => {
    if (id === "zod") return require(id);
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react-native") return { Text: "Text", View: "View" };
    if (id === "@getpaseo/plugin/client/react-native") return { Icon: "Icon" };
    if (id === "react") return {};
    throw new Error(`Unexpected module ${id}`);
  });
  let renderer;
  ui.contributeTimeline({ addTimelineRenderer: r => { renderer = r; } });
  assert.equal(renderer.kind, "deferred-message"); assert.equal(renderer.version, 1);
  assert.equal(renderer.schema.safeParse({ state: "invalid" }).success, false);
  const item = { type: "plugin", kind: "deferred-message", version: 1, data: { state: "settled" } };
  const props = { item, theme: { colors: { foreground: "black", surface1: "white", border: "gray" } }, layout: { compact: true } };
  assert.equal(renderer.Component(props), null);
  props.item = { ...item, data: f.world.calls[0].data };
  const text = JSON.stringify(renderer.Component(props)); assert.ok(text.includes("Deferred message")); assert.ok(text.includes("Review this change")); assert.ok(text.includes("when the agent is idle"));
  props.item = { ...item, data: { ...f.world.calls[0].data, trigger: { kind: "sessionReset" }, dueAt: null } };
  assert.ok(JSON.stringify(renderer.Component(props)).includes("Waiting for session reset"));
  await manager.stop(); const count = f.world.calls.length; await manager.refresh(); assert.equal(f.world.calls.length, count);
  console.log("  ✓ deferred timeline: stable rows, edits, sending/failure visibility, sent/cancel cleanup, restart and lost-ack recovery, bounded previews, renderer and invisible settled rows");
} finally { await Promise.all(managers.map(m => m.stop())); await rm(directory, { recursive: true, force: true }); }
