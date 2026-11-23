import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sdk = {
  defineSettings: definition => definition,
  settingsRpc: id => ({ read: { name: `settings.${id}.read` } }),
};
function load(path, extra = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(id => {
    if (id in extra) return extra[id];
    if (id === "@getpaseo/plugin") return sdk;
    if (id === "zod") return require(id);
    if (id === "./settings-feed/index") return load("./client/settings-feed/index.ts");
    return {};
  }, module, module.exports);
  return module.exports;
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(feeds) {
  const shared = load("./shared/display.ts");
  const { contributeDisplay } = load("./client/display.tsx", {
    "../shared/display": shared,
    "./sidebar-visibility": load("./client/sidebar-visibility.ts"),
  });
  let visible = true, reads = 0, push, closed = 0, removed = 0;
  let values = shared.displayPreferences.schema.parse({ showSidebar: true });
  const register = () => { visible = true; return () => { visible = false; }; };
  const client = {
    addSidebarHeaderItem: register,
    addSettingsScreen: () => () => { removed++; },
    addCommandCenterItem: () => () => { removed++; },
    addScreen: () => () => { removed++; },
    rpc: async () => { reads++; return { status: "ready", revision: String(reads), values }; },
    ...(feeds ? { subscribe(contract, _input, event) {
      assert.equal(contract.name, shared.displayFeed.name);
      push = event;
      return Object.assign(() => { closed++; }, { ready: Promise.resolve() });
    } } : {}),
  };
  const stop = contributeDisplay(client);
  return {
    stop, get visible() { return visible; }, get reads() { return reads; },
    get closed() { return closed; }, get removed() { return removed; },
    setValues(next) { values = shared.displayPreferences.schema.parse(next); },
    change(next) { push?.({ status: "ready", revision: "changed", values: shared.displayPreferences.schema.parse(next) }); },
    invalid() { push?.({ status: "ready", values: { showSidebar: "invalid" } }); },
  };
}
function timers() {
  const previous = { setTimeout, clearTimeout, setInterval, clearInterval };
  let next = 0; const jobs = new Map();
  globalThis.setTimeout = (fn, ms) => { const id = ++next; jobs.set(id, { fn, ms, interval: false }); return id; };
  globalThis.setInterval = (fn, ms) => { const id = ++next; jobs.set(id, { fn, ms, interval: true }); return id; };
  globalThis.clearTimeout = globalThis.clearInterval = id => { jobs.delete(id); };
  return { jobs, restore() { Object.assign(globalThis, previous); } };
}
test("a pushed settings change reaches the display without a polling read", async () => {
  const clock = timers(); let f;
  try {
    f = fixture(true); await flush();
    assert.equal(f.reads, 0, "a healthy feed must not perform the old polling read");
    f.change({ showSidebar: false, showFooter: false }); await flush();
    assert.equal(f.visible, false);
    f.invalid(); await flush(); assert.equal(f.visible, false, "invalid documents keep the last valid value");
    f.change({ showSidebar: true }); await flush(); assert.equal(f.visible, true);
    assert.equal([...clock.jobs.values()].filter(job => job.interval).length, 0);
    f.stop(); const afterStop = f.visible; f.change({ showSidebar: !afterStop }); await flush();
    assert.equal(f.visible, afterStop, "late events cannot change the display after unload");
    assert.equal(f.reads, 0); assert.equal(f.closed, 1); assert.equal(clock.jobs.size, 0);
  } finally { f?.stop(); clock.restore(); }
});
test("older clients read once a minute and stop all work on unload", async () => {
  const clock = timers(); let f;
  try {
    f = fixture(false); await flush(); assert.equal(f.reads, 1);
    const polls = [...clock.jobs.values()].filter(job => job.interval);
    assert.equal(polls.length, 1); assert.equal(polls[0].ms, 60_000);
    f.setValues({ showSidebar: false }); polls[0].fn(); await flush(); assert.equal(f.reads, 2); assert.equal(f.visible, false);
    f.stop(); polls[0].fn(); await flush();
    assert.equal(f.reads, 2); assert.equal(clock.jobs.size, 0); assert.ok(f.removed >= 2);
  } finally { f?.stop(); clock.restore(); }
});
