#!/usr/bin/env node
// GitHub release notes, one shape across Tom's plugins. Identical in every repo; keep the copies in sync.
//   node scripts/release-notes.mjs <tag>            print the release body
//   node scripts/release-notes.mjs --check <tag>    fail when a stable/rc tag has no curated notes file
//   --plugin-dir <dir> reads package.json and paseo-plugin.json from <dir> (send-to-paseo keeps them in plugin/)
// Betas (a version with a prerelease part and no rc): generated from the PRs merged since the previous tag.
// Stable and rc: release-notes/<version>.md, written by hand, grouped New / Improved / Fixed. See AGENTS.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GROUPS = ["New", "Improved", "Fixed"];
const HIDDEN = new Set(["docs", "chore", "ci", "test", "tests", "refactor", "build", "style", "perf-internal", "release"]);

export const parseVersion = tag => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : null } : null;
};

export const compareVersions = (a, b) => {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p - +q; } else if (pn !== qn) return pn ? -1 : 1; else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
};

/** The release's channel: beta (generated), or stable/rc (curated file). */
export const kindOf = tag => {
  const v = parseVersion(tag);
  if (!v) throw new Error(`"${tag}" is not a vX.Y.Z version tag`);
  return v.pre && !/^rc(\.|$)/.test(v.pre[0]) ? "beta" : "curated";
};

/** A curated file serves the stable version, and a major's rc serves the same file as its final release. */
export const notesFileFor = tag => `release-notes/${tag.replace(/^v/, "").replace(/-rc(\.\d+)?$/, "")}.md`;

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

/** "fix(brief): Stale cards (#12)" -> { type: "fix", text: "Stale cards" }. Null when the change isn't user-visible. */
export const classify = subject => {
  let s = subject.replace(/\s*\(#\d+\)\s*$/, "").trim();
  if (!s || /^merge\b/i.test(s) || /^chore: release\b/i.test(s) || /^revert\b/i.test(s)) return null;
  const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(s);
  const type = m ? m[1].toLowerCase() : "";
  if (m) s = m[2];
  if (HIDDEN.has(type)) return null;
  return { type, text: capitalize(s.replace(/\s*[—–]\s*/g, ", ").replace(/\.$/, "")) };
};

const groupOf = type => (type === "feat" ? "New" : type === "fix" ? "Fixed" : "Improved");

/** prs: [{ title, bot }]. Returns the markdown bullets, grouped, in merge order. */
export const renderChanges = prs => {
  const by = { New: [], Improved: [], Fixed: [] };
  for (const pr of prs) {
    if (pr.bot) continue;
    const c = classify(pr.title);
    if (c && !by[groupOf(c.type)].includes(c.text)) by[groupOf(c.type)].push(c.text);
  }
  const used = GROUPS.filter(g => by[g].length);
  if (!used.length) return "Maintenance release. Nothing changes for you.";
  return used.map(g => `### ${g}\n\n${by[g].map(t => `- ${t}`).join("\n")}`).join("\n\n");
};

export const installBlock = ({ pkg, version, minPaseo, prerelease, stable }) => {
  const cmd = prerelease ? `paseo plugin install npm:${pkg}@${version}` : `paseo plugin install ${pkg}`;
  const lines = ["## Install", "", "```", cmd, "```", ""];
  if (prerelease) lines.push(`A beta: npm's \`beta\` dist-tag, never \`latest\`.${stable ? ` The stable release stays ${stable}.` : ""}`);
  else lines.push(`Already installed: \`paseo plugin update ${pkg}\`.`);
  if (minPaseo) lines.push(`Needs Paseo ${minPaseo.replace(/^>=/, "")} or newer.`);
  return lines.join("\n");
};

export const render = ({ tag, pkg, minPaseo, stable, changes, curated }) => {
  const version = tag.replace(/^v/, "");
  const head = curated ? curated.trim() : `## What's new in ${version}\n\n${changes}`;
  return `${head}\n\n${installBlock({ pkg, version, minPaseo, prerelease: parseVersion(tag).pre !== null, stable })}\n`;
};

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const previousTag = (tag, tags) =>
  tags.filter(t => parseVersion(t) && compareVersions(t, tag) < 0).sort(compareVersions).pop() || null;

const mergedPrs = tag => {
  const prev = previousTag(tag, sh("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean));
  const range = prev ? `${prev}..${tag}` : tag;
  const out = [];
  for (const line of sh("git", ["log", "--first-parent", "--format=%H%x09%s", range]).split("\n").filter(Boolean)) {
    const [, subject] = line.split("\t");
    const n = /Merge pull request #(\d+)/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1];
    if (!n) { out.push({ title: subject }); continue; }
    try {
      const pr = JSON.parse(sh("gh", ["pr", "view", n, "--json", "title,author"]));
      out.push({ title: pr.title, bot: pr.author?.is_bot === true });
    } catch { out.push({ title: subject.replace(/^Merge pull request #\d+ from \S+\s*/, "") || subject }); }
  }
  return out;
};

const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});

const main = () => {
  const args = process.argv.slice(2);
  const at = args.indexOf("--plugin-dir");
  const dir = at >= 0 ? args.splice(at, 2)[1] : ".";
  const check = args[0] === "--check";
  const tag = check ? args[1] : args[0];
  if (!tag) { console.error("usage: release-notes.mjs [--check] <vX.Y.Z[-beta.N]>"); process.exit(2); }
  const kind = kindOf(tag);
  const file = notesFileFor(tag);
  if (kind === "curated" && !existsSync(file)) {
    console.error(`::error::${tag} is a stable or rc release and needs curated notes in ${file} (New / Improved / Fixed). See AGENTS.md "Release notes".`);
    process.exit(1);
  }
  if (check) return;
  const pkg = readJson(`${dir}/package.json`).name;
  const minPaseo = readJson(`${dir}/paseo-plugin.json`).requirements?.paseo;
  let stable = "";
  if (kind === "beta") { try { stable = sh("npm", ["view", pkg, "dist-tags.latest", "--registry", "https://registry.npmjs.org"]); } catch {} }
  process.stdout.write(render({ tag, pkg, minPaseo, stable, changes: kind === "beta" ? renderChanges(mergedPrs(tag)) : "", curated: kind === "curated" ? readFileSync(file, "utf8") : "" }));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
