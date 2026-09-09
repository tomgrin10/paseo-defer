/**
 * Proves the plugin subprocess can exit after cleanup.
 *
 * The v0.8 server entry owns the daemon handlers and imports the scheduler as
 * a normal server module. This runs that entry against an isolated PASEO_HOME
 * and verifies that the scheduler's interval is released by its cleanup.
 */
import * as esbuild from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SDK_SPECIFIERS, unusedPlatformModulePlugin } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, "index.server.ts");
const EXIT_BUDGET_MS = 10_000;

const stubSdkModules = {
  name: "stub-sdk-modules",
  setup(build) {
    const filter = new RegExp(
      `^(${SDK_SPECIFIERS.map((id) => id.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")).join("|")})$`,
    );
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "sdk-stub" }));
    build.onLoad({ filter: /.*/, namespace: "sdk-stub" }, () => ({
      contents: "module.exports = { defineRpc: (d) => d, defineAttachmentSource: (d) => d };",
      loader: "js",
    }));
  },
};

const built = await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node20",
  plugins: [stubSdkModules, unusedPlatformModulePlugin("server")],
  logLevel: "silent",
});

const sandbox = mkdtempSync(join(tmpdir(), "defer-teardown-"));
const bundlePath = join(sandbox, "bundle.cjs");
const harnessPath = join(sandbox, "harness.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
writeFileSync(
  harnessPath,
  `const mod = require(${JSON.stringify(bundlePath)});
const contribute = mod.default ?? mod;
const server = new Proxy({}, { get: () => () => {} });
(async () => {
  const cleanup = contribute(server);
  if (typeof cleanup !== "function") throw new Error("contribute() must return a cleanup function");
  await cleanup();
  console.log("CLEANUP_RETURNED");
})();
`,
);

const child = spawn(process.execPath, [harnessPath], {
  env: { ...process.env, PASEO_HOME: sandbox },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const exitCode = await new Promise((settle) => {
  const timer = setTimeout(() => settle(null), EXIT_BUDGET_MS);
  child.on("exit", (code) => {
    clearTimeout(timer);
    settle(code ?? 0);
  });
});
if (exitCode === null) child.kill("SIGKILL");
rmSync(sandbox, { recursive: true, force: true });

if (!output.includes("CLEANUP_RETURNED")) {
  console.error("  ✗ teardown: cleanup never returned");
  console.error(output.trim().split("\n").slice(-6).map((line) => `      ${line}`).join("\n"));
  process.exitCode = 1;
} else if (exitCode === null) {
  console.error(`  ✗ teardown: still alive ${EXIT_BUDGET_MS}ms after cleanup`);
  process.exitCode = 1;
} else {
  console.log("  ✓ teardown: server subprocess exited after cleanup");
}
