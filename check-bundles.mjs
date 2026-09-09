/**
 * Proves the v0.8 client and server runtime entries compile independently and
 * that the client registrations satisfy Paseo's current contribution shape.
 */
import * as esbuild from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle, CLIENT_EXTERNALS, SERVER_EXTERNALS, unusedPlatformModulePlugin } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRIES = {
  client: resolve(DIR, "index.client.tsx"),
  server: resolve(DIR, "index.server.ts"),
};

async function build(target) {
  return esbuild.build({
    entryPoints: [ENTRIES[target]],
    bundle: true,
    write: false,
    format: "cjs",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    supported: target === "client" ? { "async-await": false } : undefined,
    external: target === "client" ? CLIENT_EXTERNALS : SERVER_EXTERNALS,
    plugins: [unusedPlatformModulePlugin(target)],
    logLevel: "silent",
  });
}

const failures = [];
function check(condition, description) {
  if (!condition) failures.push(description);
}

async function runClientBundle(code) {
  const zod = await import("zod");
  const react = {};
  const jsxRuntime = { Fragment: "Fragment", jsx: () => null, jsxs: () => null };
  const stubs = {
    zod,
    react,
    "react/jsx-runtime": jsxRuntime,
    "react-native": {},
    "@tanstack/react-query": {},
    "@getpaseo/plugin": { defineRpc: (definition) => definition },
    "@getpaseo/plugin/client": {},
    "@getpaseo/plugin/client/react-native": { Icon: () => null, useToast: () => ({}) },
  };
  const summary = [];
  const ids = new Set();
  const client = {
    paseo: {
      agents: {
        subscribe() {
          return () => {};
        },
        async list() {
          return { entries: [], pageInfo: {} };
        },
      },
    },
    async rpc() {
      return { items: [], sessionResetsAt: null, usageError: null, settings: { pillMode: "always" } };
    },
    openSurface() {},
    openPanel() {},
    addSurface(id, Component) {
      check(typeof id === "string" && typeof Component === "function", `surface ${id} is valid`);
      summary.push(`surface:${id}`);
      return () => {};
    },
    addSidebarItem(item) {
      check(typeof item?.id === "string" && typeof item?.surface === "string", "sidebar item is valid");
      check(!ids.has(`sidebar:${item.id}`), `sidebar id ${item.id} is unique`);
      ids.add(`sidebar:${item.id}`);
      summary.push(`sidebar:${item.id}`);
      return () => {};
    },
    addWorkspacePanel(panel) {
      check(typeof panel?.id === "string" && typeof panel?.Component === "function", "workspace panel is valid");
      check(!ids.has(`panel:${panel.id}`), `panel id ${panel.id} is unique`);
      ids.add(`panel:${panel.id}`);
      summary.push(`panel:${panel.id}`);
      return () => {};
    },
    addCommandCenterItem(item) {
      check(typeof item?.id === "string" && typeof item?.onSelect === "function", "Command Center item is valid");
      check(!ids.has(`command:${item.id}`), `Command Center id ${item.id} is unique`);
      ids.add(`command:${item.id}`);
      summary.push(`command:${item.id}`);
      return () => {};
    },
    addComposerPill(contribution) {
      const button = contribution?.button;
      check(typeof button?.title === "string" && button.title.trim() !== "", "composer pill has a button title");
      check(button?.icon === "Clock", "composer pill has a Lucide icon");
      check(button?.behavior?.kind === "action" || button?.behavior?.kind === "popover", "composer pill has a v0.8 behavior");
      summary.push(`pill:${contribution.id}`);
      return { update() {}, remove() {} };
    },
  };
  const exported = instantiateBundle(code, (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`Module "${id}" is not available in the client bundle`);
  });
  const contribute = exported?.default;
  check(typeof contribute === "function", "client entry exports a contribution function");
  const cleanup = contribute(client);
  check(typeof cleanup === "function", "client contribution returns cleanup");
  await cleanup();
  return summary;
}

console.log("Checking plugin runtime boundary...");
try {
  const clientBuild = await build("client");
  const summary = await runClientBundle(clientBuild.outputFiles[0].text);
  console.log(`  ✓ client: builds and registers ${summary.join(", ")}`);
} catch (error) {
  failures.push(`client: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  await build("server");
  console.log("  ✓ server: builds as a separate daemon entry");
} catch (error) {
  failures.push(`server: ${error instanceof Error ? error.message : String(error)}`);
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Runtime boundary check failed.");
  process.exitCode = 1;
} else {
  console.log("Runtime boundary OK.");
}
