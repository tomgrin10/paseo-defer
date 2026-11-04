/** Proves every short-lived daemon connection receives the best available password. */
import * as esbuild from "esbuild";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const built = await esbuild.build({
  entryPoints: [resolve(DIR, "server/daemon.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["node:fs/promises", "node:os", "node:path"],
  logLevel: "silent",
});
const CODE = built.outputFiles[0].text;

const failures = [];
function check(condition, description) {
  if (!condition) failures.push(description);
}

function load(files = new Map()) {
  const options = [];
  const reads = [];
  const usageReads = [];
  class DaemonClient {
    constructor(input) {
      options.push(input);
    }
    async connect() {}
    async close() {}
    async listProviderUsage() {
      usageReads.push(true);
      return {
        providers: [
          {
            providerId: "provider-a",
            windows: [{ id: "session", resetsAt: "2026-09-02T15:00:00Z", usedPct: 86.4 }],
          },
          {
            providerId: "provider-b",
            windows: [{ id: "session", resetsAt: "2026-09-02T20:00:00Z" }],
          },
        ],
      };
    }
  }
  const graph = instantiateBundle(CODE, (id) => {
    if (id === "node:path") return path;
    if (id === "node:os") return { homedir: () => "/home/paseo" };
    if (id === "node:fs/promises") {
      return {
        async readFile(file) {
          reads.push(file);
          if (files.has(file)) return files.get(file);
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      };
    }
    if (id === "@getpaseo/client/internal/daemon-client") return { DaemonClient };
    throw new Error(`Unexpected module ${id}`);
  });
  return { graph, options, reads, usageReads };
}

const previous = {
  url: process.env.PASEO_DAEMON_URL,
  password: process.env.PASEO_PASSWORD,
  passwordFile: process.env.PASEO_PASSWORD_FILE,
};

async function connect(runtime) {
  await runtime.graph.withDaemon(async () => undefined);
  return runtime.options[0];
}

try {
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:6767/ws";

  process.env.PASEO_PASSWORD = " standard-secret ";
  process.env.PASEO_PASSWORD_FILE = "/run/paseo/password";
  let runtime = load(new Map([["/run/paseo/password", "file-secret\n"]]));
  check((await connect(runtime))?.password === "standard-secret", "PASEO_PASSWORD wins");
  check(runtime.reads.length === 0, "the password file is not read when the env password exists");

  delete process.env.PASEO_PASSWORD;
  runtime = load(new Map([["/run/paseo/password", "file-secret\n"]]));
  check((await connect(runtime))?.password === "file-secret", "PASEO_PASSWORD_FILE is supported");

  delete process.env.PASEO_PASSWORD_FILE;
  const vmFile = "/home/paseo/paseo-hub/secrets/daemon-password";
  runtime = load(new Map([[vmFile, "vm-secret\n"]]));
  check((await connect(runtime))?.password === "vm-secret", "the paseo-vm secret convention works");

  runtime = load();
  check(!("password" in (await connect(runtime))), "password is omitted when no source exists");

  const firstProvider = await runtime.graph.fetchSessionResetsAt("provider-a");
  const secondProvider = await runtime.graph.fetchSessionResetsAt("provider-b");
  const firstProviderAgain = await runtime.graph.fetchSessionResetsAt("provider-a");
  check(firstProvider === "2026-09-02T15:00:00.000Z", "the first provider's reset is selected");
  check(secondProvider === "2026-09-02T20:00:00.000Z", "a second provider does not reuse the first provider's cache");
  check(firstProviderAgain === firstProvider, "a provider reuses its own cached reset");
  check(runtime.usageReads.length === 2, "usage is fetched once per provider within the cache window");
  const firstWindow = await runtime.graph.fetchSessionWindow("provider-a");
  const secondWindow = await runtime.graph.fetchSessionWindow("provider-b");
  check(firstWindow.usedPct === 86.4 && firstWindow.resetsAt === firstProvider, "the window read carries the share already used");
  check(secondWindow.usedPct === null, "a provider that reports no share claims none");
  check(runtime.usageReads.length === 2, "the share comes from the same cached read");

  process.env.PASEO_PASSWORD_FILE = "/run/paseo/missing";
  runtime = load();
  await runtime.graph.resolvePassword().then(
    () => failures.push("an unreadable explicit password file must fail closed"),
    (error) =>
      check(
        String(error) === "Error: PASEO_PASSWORD_FILE could not be read.",
        "the explicit-file error reveals no secret material",
      ),
  );
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  for (const [key, value] of [
    ["PASEO_DAEMON_URL", previous.url],
    ["PASEO_PASSWORD", previous.password],
    ["PASEO_PASSWORD_FILE", previous.passwordFile],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Daemon authentication check failed.");
  process.exit(1);
}
console.log("  ✓ daemon auth and provider-scoped usage caching behave");
