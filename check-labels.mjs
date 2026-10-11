/** Durable workspace labels: aggregation, moves, lost acknowledgements, and cleanup. */
import { build } from "esbuild";
import { instantiateBundle } from "./check-lib.mjs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const built = await build({ entryPoints: ["server/labels.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const { WorkspaceLabels } = instantiateBundle(built.outputFiles[0].text, createRequire(import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "defer-labels-check-"));
const managers = [];
function fixture(name) {
  const path = join(directory, name);
  const world = { items: [{ id: "1", agentId: "a", state: "pending" }, { id: "2", agentId: "b", state: "sending" }],
    agents: new Map([["a", "w"], ["b", "w"]]), labels: new Map([["w", new Set(["Paused", "Review"])] ]), calls: [], beforeSet: null, beforeConnect: null, lookupFails: false };
  const client = {
    close: async () => {},
    fetchAgent: async id => {
      if (world.lookupFails) throw new Error("private daemon details must never reach logs");
      return { agent: { workspaceId: world.agents.get(id) } };
    },
    setWorkspaceLabel: async input => {
      assert.deepEqual(input.label, { name: "Deferred", color: "blue" });
      if (input.assigned) assert.ok(JSON.parse(await readFile(join(path, "workspace-labels.json"), "utf8")).workspaceIds.includes(input.workspaceId));
      world.calls.push(structuredClone(input));
      const labels = world.labels.get(input.workspaceId) ?? new Set();
      input.assigned ? labels.add(input.label.name) : labels.delete(input.label.name);
      world.labels.set(input.workspaceId, labels);
      await world.beforeSet?.(input);
    },
  };
  const manager = () => {
    const labels = new WorkspaceLabels(path, async () => world.items, async work => { await world.beforeConnect?.(); return work(client); });
    managers.push(labels); return labels;
  };
  return { world, path, manager };
}
try {
  const f = fixture("aggregate"); const labels = f.manager();
  await labels.refresh(); assert.equal(labels.error, null);
  assert.deepEqual([...f.world.labels.get("w")], ["Paused", "Review", "Deferred"]);
  f.world.items[0].state = "cancelled"; await labels.refresh(); assert.ok(f.world.labels.get("w").has("Deferred"));
  f.world.items[1].state = "sent"; await labels.refresh();
  assert.deepEqual([...f.world.labels.get("w")], ["Paused", "Review"]);
  assert.deepEqual(JSON.parse(await readFile(join(f.path, "workspace-labels.json"), "utf8")), { version: 1, workspaceIds: [] });
  assert.equal((await stat(join(f.path, "workspace-labels.json"))).mode & 0o777, 0o600);

  const reload = fixture("reload"); const first = reload.manager(); await first.refresh(); await first.stop();
  const second = reload.manager(); await second.refresh(); assert.ok(reload.world.labels.get("w").has("Deferred"));
  reload.world.items = []; await second.refresh(); assert.ok(!reload.world.labels.get("w").has("Deferred"));

  const lost = fixture("lost-ack"); let once = true;
  lost.world.beforeSet = async () => { if (once) { once = false; throw new Error("lost ack"); } };
  const broken = lost.manager(); await broken.refresh(); assert.match(broken.error, /awaiting delivery/);
  assert.deepEqual(JSON.parse(await readFile(join(lost.path, "workspace-labels.json"), "utf8")).workspaceIds, ["w"]);
  await broken.stop(); lost.world.items = []; const recovered = lost.manager(); await recovered.refresh();
  assert.equal(recovered.error, null); assert.ok(!lost.world.labels.get("w").has("Deferred"));

  const moving = fixture("moving"); const moves = moving.manager(); await moves.refresh();
  moving.world.agents.set("a", "new"); await moves.refresh();
  assert.ok(moving.world.labels.get("new").has("Deferred")); assert.ok(moving.world.labels.get("w").has("Deferred"));
  moving.world.items[1].state = "failed"; await moves.refresh(); assert.ok(!moving.world.labels.get("w").has("Deferred"));
  assert.ok(moving.world.labels.get("new").has("Deferred"));

  const race = fixture("slow-cancel"); let release, started;
  const gate = new Promise(resolve => { release = resolve; }); const began = new Promise(resolve => { started = resolve; });
  race.world.beforeSet = async input => { if (input.assigned) { started(); await gate; } };
  const racer = race.manager(); const pending = racer.refresh(); await began;
  race.world.items = []; const changed = racer.refresh(); release(); await Promise.all([pending, changed]);
  assert.deepEqual(race.world.calls.map(c => c.assigned), [true, false]); assert.ok(!race.world.labels.get("w").has("Deferred"));

  const stop = fixture("slow-stop"); let unblock, entered;
  const blocked = new Promise(resolve => { unblock = resolve; }); const entering = new Promise(resolve => { entered = resolve; });
  stop.world.beforeSet = async () => { entered(); await blocked; };
  const stopping = stop.manager(); const active = stopping.refresh(); await entering;
  let drained = false; const drain = stopping.stop().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); unblock(); await Promise.all([active, drain]);
  assert.equal(drained, true); const calls = stop.world.calls.length; await stopping.refresh(); assert.equal(stop.world.calls.length, calls);
  stop.world.items = []; await stop.manager().refresh(); assert.ok(!stop.world.labels.get("w").has("Deferred"));

  const connecting = fixture("stop-during-connect"); const owner = connecting.manager(); await owner.refresh();
  connecting.world.items = []; let finishConnect, connectStarted;
  const connectingGate = new Promise(resolve => { finishConnect = resolve; });
  const connectionBegan = new Promise(resolve => { connectStarted = resolve; });
  connecting.world.beforeConnect = async () => { connectStarted(); await connectingGate; };
  const removal = owner.refresh(); await connectionBegan; const stopped = owner.stop(); finishConnect();
  await Promise.all([removal, stopped]);
  assert.ok(connecting.world.labels.get("w").has("Deferred"));
  assert.deepEqual(JSON.parse(await readFile(join(connecting.path, "workspace-labels.json"), "utf8")).workspaceIds, ["w"]);
  connecting.world.beforeConnect = null; await connecting.manager().refresh(); assert.ok(!connecting.world.labels.get("w").has("Deferred"));

  const offline = fixture("offline"); const retry = offline.manager(); await retry.refresh(); offline.world.lookupFails = true;
  const logs = []; const original = console.error; console.error = message => logs.push(message);
  try { await retry.refresh(); await retry.refresh(); } finally { console.error = original; }
  assert.ok(offline.world.labels.get("w").has("Deferred")); assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("private daemon details"));
  offline.world.lookupFails = false; await retry.refresh(); assert.equal(retry.error, null);
  await writeFile(join(offline.path, "workspace-labels.json"), '{"version":999,"workspaceIds":[]}');
  const count = offline.world.calls.length; await retry.refresh(); assert.equal(offline.world.calls.length, count); assert.match(retry.error, /awaiting delivery/);
  console.log("  ✓ workspace labels: aggregate pending/sending, preserve other labels, restore ownership, follow moves, retry safely, and drain cleanup");
} finally {
  await Promise.all(managers.map(manager => manager.stop()));
  await rm(directory, { recursive: true, force: true });
}
