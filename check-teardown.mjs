/**
 * Proves the plugin subprocess can exit after cleanup.
 *
 * Paseo stops a plugin by running the cleanup returned from contribute() and
 * then waiting for the subprocess to exit. Anything still holding the event
 * loop -- an uncleared interval, an open socket -- makes that wait never
 * finish, leaving the plugin stuck "Stopping" and wedging reload for the rest
 * of the daemon's life. Typecheck and the bundle check cannot see this.
 *
 * Runs against an isolated PASEO_HOME so the real queue is never touched.
 */
import * as esbuild from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const EXIT_BUDGET_MS = 10_000;
const CLIENT_ONLY = /^(react|react\/jsx-runtime|react-native|@tanstack\/react-query|@getpaseo\/plugin(\/server)?)$/;

// Mirrors createUnusedPlatformModulePlugin for the server target.
const stubClientModules = {
  name: "stub-client-modules",
  setup(build) {
    build.onResolve({ filter: CLIENT_ONLY }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = { defineRpc: (d) => d, defineAttachmentSource: (d) => d };",
      loader: "js",
    }));
  },
};

const built = await esbuild.build({
  entryPoints: [resolve(DIR, "index.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node20",
  plugins: [stubClientModules],
  absWorkingDir: DIR,
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
const plugin = new Proxy({}, { get: () => () => {} });
(async () => {
  const cleanup = contribute(plugin);
  if (typeof cleanup === "function") await cleanup();
  console.log("CLEANUP_RETURNED");
})();
`,
);

const child = spawn(process.execPath, [harnessPath], {
  env: { ...process.env, PASEO_HOME: sandbox },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (chunk) => (out += chunk));
child.stderr.on("data", (chunk) => (out += chunk));

const exitCode = await new Promise((settle) => {
  const timer = setTimeout(() => settle(null), EXIT_BUDGET_MS);
  child.on("exit", (code) => {
    clearTimeout(timer);
    settle(code ?? 0);
  });
});
if (exitCode === null) child.kill("SIGKILL");
rmSync(sandbox, { recursive: true, force: true });

if (!out.includes("CLEANUP_RETURNED")) {
  console.error("  ✗ teardown: cleanup never returned");
  console.error(out.trim().split("\n").slice(-6).map((line) => `      ${line}`).join("\n"));
  process.exitCode = 1;
} else if (exitCode === null) {
  console.error(`  ✗ teardown: still alive ${EXIT_BUDGET_MS}ms after cleanup — Paseo's stop would hang here`);
  process.exitCode = 1;
} else {
  console.log("  ✓ teardown: subprocess exited after cleanup");
}
