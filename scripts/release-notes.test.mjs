import test from "node:test";
import assert from "node:assert/strict";
import { classify, compareVersions, kindOf, notesFileFor, previousTag, render, renderChanges } from "./release-notes.mjs";

test("versions order with prereleases before their release", () => {
  const tags = ["v2.4.0", "v2.4.1-beta.1", "v2.4.1-beta.0", "v2.3.0", "v2.4.1-beta.10", "v2.4.1"];
  assert.deepEqual([...tags].sort(compareVersions), ["v2.3.0", "v2.4.0", "v2.4.1-beta.0", "v2.4.1-beta.1", "v2.4.1-beta.10", "v2.4.1"]);
  assert.equal(previousTag("v2.4.1-beta.1", tags), "v2.4.1-beta.0");
  assert.equal(previousTag("v2.4.1-beta.0", tags), "v2.4.0");
  assert.equal(previousTag("v1.0.0", ["v1.0.0"]), null);
});

test("betas are generated, stable and rc are curated", () => {
  assert.equal(kindOf("v2.4.1-beta.0"), "beta");
  assert.equal(kindOf("v2.4.1"), "curated");
  assert.equal(kindOf("v2.0.0-rc.1"), "curated");
  assert.equal(notesFileFor("v2.0.0-rc.1"), "release-notes/2.0.0.md");
  assert.equal(notesFileFor("v2.4.1"), "release-notes/2.4.1.md");
  assert.throws(() => kindOf("main"));
});

test("a change reads as a sentence, and non-user-visible work is dropped", () => {
  assert.deepEqual(classify("fix(brief): stale cards — again (#12)"), { type: "fix", text: "Stale cards, again" });
  assert.deepEqual(classify("Open workspace: show owners"), { type: "", text: "Open workspace: show owners" });
  for (const s of ["docs: readme", "ci(publish): x", "chore: release v1.0.0", "Merge pull request #3 from a/b", "test: more"]) assert.equal(classify(s), null, s);
});

test("changes group as New, Improved, Fixed, skip bots and duplicates", () => {
  const out = renderChanges([
    { title: "fix: remember which plugin id answered" },
    { title: "feat(ui): a Deferred screen" },
    { title: "Bump x from 1 to 2", bot: true },
    { title: "fix: remember which plugin id answered" },
    { title: "docs: notes" },
    { title: "Faster popover" },
  ]);
  assert.equal(out, "### New\n\n- A Deferred screen\n\n### Improved\n\n- Faster popover\n\n### Fixed\n\n- Remember which plugin id answered");
  assert.equal(renderChanges([{ title: "ci: x" }]), "Maintenance release. Nothing changes for you.");
});

test("the body ends with the install block for the channel", () => {
  const beta = render({ tag: "v1.1.0-beta.0", pkg: "paseo-vitals", minPaseo: ">=0.14.0", stable: "1.0.0", changes: "### Fixed\n\n- X" });
  assert.match(beta, /^## What's new in 1\.1\.0-beta\.0\n\n### Fixed/);
  assert.match(beta, /paseo plugin install npm:paseo-vitals@1\.1\.0-beta\.0/);
  assert.match(beta, /stable release stays 1\.0\.0/);
  assert.match(beta, /Needs Paseo 0\.14\.0 or newer\.\n$/);
  const stable = render({ tag: "v2.0.0", pkg: "p", minPaseo: ">=0.15.0", curated: "Summary.\n\n### New\n\n- A\n" });
  assert.match(stable, /^Summary\.\n\n### New\n\n- A\n\n## Install\n\n```\npaseo plugin install p\n```/);
  assert.doesNotMatch(stable, /beta/);
});

import { readFileSync } from "node:fs";
const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");

test("a stable tag without curated notes fails before publishing, and the release body comes from the generator", () => {
  const check = workflow.indexOf("release-notes.mjs --check");
  assert.ok(check > 0 && check < workflow.indexOf('["publish"'));
  assert.match(workflow, /gh release create[\s\S]*--notes-file/);
  assert.doesNotMatch(workflow, /--generate-notes/);
});
