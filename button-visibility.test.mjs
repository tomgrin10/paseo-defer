import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function fixture() {
  let listener;
  const source = ts.transpileModule(readFileSync(new URL("./client/button-visibility.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(() => ({ subscribeDisplay(fn) { listener = fn; return () => { listener = undefined; }; } }), module, module.exports);
  const active = new Map();
  const registered = [];
  const register = input => {
    assert.ok(!active.has(input.id), "a contribution must never be registered twice");
    const state = { ...input.button }; registered.push(state); active.set(input.id, state);
    return { update(patch) { Object.assign(state, patch); }, remove() { active.delete(input.id); } };
  };
  const adapted = module.exports.withButtonVisibility({ addHeaderButton: register, addComposerPill: register });
  return { ...adapted, active, registered, save(values) { listener?.({ enable_header_button: true, enable_composer_button: true, ...values }); } };
}

test("hidden buttons preserve current descriptors, cover newly discovered workspaces, and return once", () => {
  const f = fixture();
  const contribution = { id: "first", workspaceId: "workspace", button: { title: "Open", label: "Original", icon: "Settings", behavior: { kind: "action", onPress() {} } } };
  const method = "composer" === "header" ? "addHeaderButton" : "addComposerPill";
  const flag = `enable_${"composer"}_button`;
  const first = f.client[method](contribution);
  f.save({ [flag]: false });
  assert.equal(f.active.size, 0);
  first.update({ label: "Current" });
  const second = f.client[method]({ ...contribution, id: "second" });
  assert.equal(f.active.size, 0, "new workspaces respect the saved hidden choice");
  second.remove();
  f.save({ [flag]: true });
  f.save({ [flag]: true });
  assert.equal(f.active.size, 1);
  assert.equal(f.active.get("first").label, "Current");
  f.dispose();
  assert.equal(f.active.size, 0);
  f.save({ [flag]: true });
  assert.equal(f.active.size, 0, "late preference changes cannot resurrect disposed buttons");
});

test("Paseo 0.16: the composer item follows the Composer button setting, and older hosts get no addComposerItem", () => {
  let listener;
  const source = ts.transpileModule(readFileSync(new URL("./client/button-visibility.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(() => ({ subscribeDisplay(fn) { listener = fn; return () => { listener = undefined; }; } }), module, module.exports);
  const save = values => listener?.({ enable_header_button: true, enable_composer_button: true, ...values });
  const mounted = new Set();
  const host = { addHeaderButton() {}, addComposerPill() {}, addComposerItem(input) { assert.ok(!mounted.has(input.id), "an item is never registered twice"); mounted.add(input.id); return () => mounted.delete(input.id); } };
  const adapted = module.exports.withButtonVisibility(host);
  const remove = adapted.client.addComposerItem({ id: "defer", Component() {} });
  assert.ok(mounted.has("defer"));
  save({ enable_composer_button: false });
  assert.equal(mounted.size, 0, "Off removes the composer item");
  save({ enable_composer_button: true });
  save({ enable_composer_button: true });
  assert.ok(mounted.has("defer"), "turning it back on restores it once");
  remove();
  assert.equal(mounted.size, 0);
  save({ enable_composer_button: true });
  assert.equal(mounted.size, 0, "a removed item stays removed");
  adapted.dispose();

  const old = module.exports.withButtonVisibility({ addHeaderButton() {}, addComposerPill() {} });
  assert.equal(typeof old.client.addComposerItem, "undefined", "a 0.15 host is not given a composer item API");
  old.dispose();
});
