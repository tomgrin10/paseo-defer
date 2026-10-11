import { build } from "esbuild";
import { instantiateBundle } from "./check-lib.mjs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const world = { items: [], states: new Map([["agent", "idle"]]), sent: [], fail: false, beforeClaim: null, lifecycle: { teardown: null } };
globalThis.__deferDelivery = world;
const stubs = {
  "./store": `export const store = {
    list: async () => [], recoverInterrupted: async () => 0,
    update: async (id, patch) => { const item = globalThis.__deferDelivery.items.find(i => i.id === id); if (!item) return null; Object.assign(item,patch); return structuredClone(item); },
    updatePending: async (id, patch) => { const w = globalThis.__deferDelivery; await w.beforeClaim?.(); const item = w.items.find(i => i.id === id); if (!item || item.state !== 'pending') return {item:null,reason:'settled'}; Object.assign(item,patch);return {item:structuredClone(item),reason:null}; }
  };`,
  "./daemon": `export const readAgentStates = async () => globalThis.__deferDelivery.states;
    export const withDaemon = async work => work({sendMessage:async (agentId,text,options) => {const w=globalThis.__deferDelivery;w.sent.push({agentId,text,options});if(w.fail)throw new Error('send failed');}});
    export const clearCaches = () => {}; export const fetchSessionResetsAt = async () => null; export const getProviderByAgentId = async () => 'codex';`,
  "../shared/lifecycle": `export const lifecycle=globalThis.__deferDelivery.lifecycle;`,
};
const built = await build({ entryPoints: ["server/engine.ts"], bundle: true, write: false, format: "cjs", platform: "node", plugins: [{ name: "delivery-stubs", setup(b) {
  b.onResolve({filter:/^(\.\/(store|daemon)|\.\.\/shared\/lifecycle)$/}, args => ({path:args.path,namespace:"stub"}));
  b.onLoad({filter:/.*/,namespace:"stub"}, args => ({contents:stubs[args.path],loader:"js"}));
} }] });
const engine = instantiateBundle(built.outputFiles[0].text, require);
await new Promise(resolve => setImmediate(resolve));
function fixture(trigger = {kind:"after",ms:3600000}) {
  const item = {id:"delivery-id",agentId:"agent",text:"Keep my original text",trigger,createdAt:"2026-10-11T00:00:00.000Z",dueAt:"2026-10-11T01:00:00.000Z",anchorResetsAt:null,state:"pending",settledAt:null,error:null};
  world.items=[item];world.sent=[];world.fail=false;world.beforeClaim=null;world.states.set("agent","idle");return item;
}
try {
  for (const trigger of [{kind:"after",ms:3600000},{kind:"at",iso:"2026-10-11T01:00:00.000Z"},{kind:"sessionReset"}]) {
    const item=fixture(trigger);if(trigger.kind==='sessionReset')item.anchorResetsAt=item.dueAt;
    await engine.deliver([structuredClone(item)]);assert.equal(item.state,"sent");assert.equal(world.sent.length,1);
    const sent=world.sent[0];assert.equal(sent.text,"Keep my original text");assert.equal(sent.options.messageId,item.id);
    assert.equal(sent.options.attachments[0].type,"text");assert.equal(sent.options.attachments[0].contextKind,"paseo-defer");
    const metadata=JSON.parse(sent.options.attachments[0].text);
    assert.equal(metadata.deferredAt,item.createdAt);assert.equal(metadata.scheduledFor,item.dueAt);assert.deepEqual(metadata.trigger,trigger);
    assert.equal(metadata.usageWindowResetsAt,item.anchorResetsAt);assert.ok(Number.isFinite(Date.parse(metadata.sentAt)));assert.ok(metadata.waitedMs>=0);assert.ok(metadata.lateByMs>=0);
  }
  const cancelled=fixture();world.beforeClaim=()=>{cancelled.state="cancelled";};await engine.deliver([structuredClone(cancelled)]);assert.equal(world.sent.length,0);assert.equal(cancelled.state,"cancelled");
  const moved=fixture();const stale=structuredClone(moved);world.beforeClaim=()=>{moved.dueAt="2099-01-01T00:00:00.000Z";};await engine.deliver([stale]);assert.equal(world.sent.length,0);assert.equal(moved.state,"pending");
  const edited=fixture();world.beforeClaim=()=>{edited.text="Edited text wins";};await engine.deliver([structuredClone(edited)]);assert.equal(world.sent[0].text,"Edited text wins");
  const busy=fixture();world.states.set("agent","running");await engine.deliver([structuredClone(busy)]);assert.equal(world.sent.length,0);assert.equal(busy.state,"pending");
  const failed=fixture();world.fail=true;await engine.deliver([structuredClone(failed)]);assert.equal(failed.state,"failed");
  console.log("  ✓ delivery: original text plus deferral metadata for every trigger, cancellation and reschedule races, fresh text, busy-session wait and failed-send settlement");
} finally { await world.lifecycle.teardown?.(); delete globalThis.__deferDelivery; }

const isolatedHome = await mkdtemp(join(tmpdir(), "defer-delete-check-"));
const previousHome = process.env.PASEO_HOME;
process.env.PASEO_HOME = isolatedHome;
try {
  const compiled = await build({ entryPoints: ["server/store.ts"], bundle: true, write: false, format: "cjs", platform: "node", external: ["zod"] });
  const { store } = instantiateBundle(compiled.outputFiles[0].text, require);
  const base = { ...fixture(), state: "pending" };
  await store.add({ ...base, id: "waiting" }); await store.add({ ...base, id: "sending", state: "sending" }); await store.add({ ...base, id: "failed", state: "failed" });
  assert.equal(await store.removeIdle("sending"), false);
  assert.equal(await store.removeIdle("waiting"), true);
  assert.equal((await store.updatePending("waiting", { state: "sending" })).reason, "missing");
  assert.equal(await store.removeIdle("failed"), true);
  assert.equal(await store.removeIdle("waiting"), true);
  assert.deepEqual((await store.list()).map(item => item.id), ["sending"]);
  console.log("  ✓ timeline delete: atomic cancellation, failed-item cleanup, sending protection, repeat deletion and isolation");
} finally {
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  await rm(isolatedHome, { recursive: true, force: true });
}
