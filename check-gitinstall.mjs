/**
 * Proves the plugin installs from Git.
 *
 * `paseo plugin add owner/repo` clones the repository and compiles it without
 * running a package manager, so anything the bundle imports statically has to
 * be either a host-provided module or source committed in this repo. A single
 * `import ... from "@getpaseo/client"` is enough to break Git installs while
 * still working perfectly from a directory install that has node_modules.
 *
 * So: copy the sources somewhere with no node_modules and compile them the way
 * the daemon does.
 */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOptions, filterEntrypoint } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = /\.tsx?$/;

console.log("Checking Git-install compatibility...");

const failures = [];

/** Files a Git clone would carry, so an uncommitted source shows up as a gap. */
function trackedFiles() {
  try {
    return new Set(
      execFileSync("git", ["ls-files"], { cwd: DIR, encoding: "utf8" })
        .split("\n")
        .filter((line) => line !== ""),
    );
  } catch {
    return null;
  }
}

const staging = mkdtempSync(join(tmpdir(), "defer-gitinstall-"));
try {
  const tracked = trackedFiles();
  const untracked = [];
  const copied = [];
  for (const name of readdirSync(DIR)) {
    if (!SOURCE.test(name)) continue;
    copyFileSync(join(DIR, name), join(staging, name));
    copied.push(name);
    if (tracked !== null && !tracked.has(name)) untracked.push(name);
  }
  // Only the entry point needs to exist for the compile; the rest are resolved
  // from it, and anything missing surfaces as a resolution error below.
  copyFileSync(join(DIR, "paseo-plugin.json"), join(staging, "paseo-plugin.json"));

  const entry = resolve(staging, "index.ts");
  const source = readFileSync(entry, "utf8");
  for (const target of ["client", "server"]) {
    const { filtered } = filterEntrypoint(source, target);
    try {
      await esbuild.build(buildOptions(entry, staging, filtered, target));
      console.log(`  ✓ ${target}: compiles with no installed dependencies`);
    } catch (error) {
      const messages = (error?.errors ?? []).map((item) => item.text);
      failures.push(
        `${target}: ${messages.length > 0 ? messages.join("; ") : String(error)}`,
      );
    }
  }

  if (untracked.length > 0) {
    // Not a failure: this is the normal state mid-change. It is a failure at
    // release time, which is why it prints loudly.
    console.log(`  ! not committed yet, so a Git install would miss: ${untracked.join(", ")}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Git-install check failed: `paseo plugin add` would not compile this plugin.");
  process.exitCode = 1;
} else {
  console.log("Git-install OK.");
}
