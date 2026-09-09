/**
 * Proves the plugin installs from Git.
 *
 * `paseo plugin add owner/repo` clones the repository and compiles the two
 * runtime entries without running a package manager, so anything imported by
 * the bundles has to be either committed source or a host-provided module.
 */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_EXTERNALS,
  SERVER_EXTERNALS,
  unusedPlatformModulePlugin,
} from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_EXTENSIONS = /\.(?:tsx?|mjs|json|md|gif)$/;

console.log("Checking Git-install compatibility...");

const failures = [];

function trackedFiles() {
  try {
    return new Set(
      execFileSync("git", ["ls-files"], { cwd: DIR, encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

function copySources(source, destination, copied, tracked) {
  for (const name of readdirSync(source)) {
    if (name === ".git" || name === "node_modules" || name.startsWith(".check-")) continue;
    const sourcePath = join(source, name);
    const relativePath = relative(DIR, sourcePath);
    const destinationPath = join(destination, relativePath);
    const stats = statSync(sourcePath);
    if (stats.isDirectory()) {
      copySources(sourcePath, destination, copied, tracked);
      continue;
    }
    if (!SOURCE_EXTENSIONS.test(name) && name !== "LICENSE") continue;
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    copied.push(relativePath);
    if (tracked !== null && !tracked.has(relativePath)) {
      console.log(`  ! not committed yet, so a Git install would miss: ${relativePath}`);
    }
  }
}

const staging = mkdtempSync(join(tmpdir(), "defer-gitinstall-"));
try {
  const tracked = trackedFiles();
  const copied = [];
  copySources(DIR, staging, copied, tracked);

  for (const [target, entryName, external] of [
    ["client", "index.client.tsx", CLIENT_EXTERNALS],
    ["server", "index.server.ts", SERVER_EXTERNALS],
  ]) {
    const entry = resolve(staging, entryName);
    try {
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "cjs",
        platform: target === "server" ? "node" : "neutral",
        target: target === "server" ? "node20" : "es2020",
        supported: target === "client" ? { "async-await": false } : undefined,
        external,
        plugins: [unusedPlatformModulePlugin(target)],
        logLevel: "silent",
      });
      console.log(`  ✓ ${target}: compiles with no installed dependencies`);
    } catch (error) {
      const messages = (error?.errors ?? []).map((item) => item.text);
      failures.push(
        `${target}: ${messages.length > 0 ? messages.join("; ") : String(error)}`,
      );
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
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
