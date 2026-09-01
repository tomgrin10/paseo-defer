/**
 * Guards the plugin runtime boundary, which typecheck cannot see.
 *
 * Paseo compiles index.ts twice. For each target it deletes the other
 * runtime's imports and the registration calls that do not apply, but leaves
 * every other statement in place. So a server identifier used anywhere in
 * contribute()'s shared body survives with its import gone and throws a
 * ReferenceError at load, which silently drops every contribution.
 *
 * The client bundle is then executed against the same validation the app
 * applies in evaluatePluginClientBundle, so a registration Paseo would reject
 * at install time fails here instead.
 */
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOptions, filterEntrypoint, findDanglingReferences } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, "index.ts");

/**
 * Executes the filtered client bundle the way the app does: a strict module
 * map that rejects anything the host does not provide, and a plugin object
 * that applies the app's validation. A permissive stub would pass
 * registrations Paseo rejects.
 */
async function runClientBundle(code) {
  const zod = await import("zod");
  const contracts = { defineRpc: (d) => d, defineAttachmentSource: (d) => d };
  const stubs = {
    zod,
    react: {},
    "react/jsx-runtime": {},
    "react-native": {},
    "@tanstack/react-query": {},
    "@getpaseo/plugin": { ...contracts, Icon: () => null },
    "@getpaseo/plugin/react-native": { Icon: () => null, Modal: () => null, useToast: () => ({}) },
    "@getpaseo/plugin/server": contracts,
  };
  const factory = new Function(
    "require",
    `const module={exports:{}};const exports=module.exports;${code};return module.exports;`,
  );
  const exported = factory((id) => {
    if (!(id in stubs)) throw new Error(`Module "${id}" is not available in plugin client code`);
    return stubs[id];
  });
  const contribute = exported?.default;
  if (typeof contribute !== "function") throw new Error("index.ts must default-export a function");

  const summary = [];
  const usedIds = new Map();
  const surfaceIds = new Set();
  const sidebarSurfaces = [];

  const requireId = (value, what) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (id === "") throw new Error(`Missing ${what}`);
    const seen = usedIds.get(what);
    if (seen === undefined) usedIds.set(what, new Set([id]));
    else if (seen.has(id)) throw new Error(`Duplicate ${what}: ${id}`);
    else seen.add(id);
    return id;
  };
  const requireText = (value, what) => {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${what}`);
  };
  const requireFn = (value, what) => {
    if (typeof value !== "function") throw new Error(`${what} is not a function`);
  };

  const plugin = {
    addSurface(id, Component) {
      const surfaceId = requireId(id, "surface id");
      requireFn(Component, `surface ${surfaceId}`);
      surfaceIds.add(surfaceId);
      summary.push(`addSurface(${surfaceId})`);
    },
    addSidebarItem(item) {
      const id = requireId(item?.id, "sidebar item id");
      requireText(item?.title, `sidebar item ${id} title`);
      requireText(item?.icon, `sidebar item ${id} icon`);
      sidebarSurfaces.push({ id, surface: requireId(item?.surface, "sidebar surface id") });
      summary.push(`addSidebarItem(${id})`);
    },
    addWorkspacePanel(panel) {
      const id = requireId(panel?.id, "workspace panel id");
      requireText(panel?.title, `panel ${id} title`);
      requireText(panel?.icon, `panel ${id} icon`);
      if (panel?.context !== "workspace" && panel?.context !== "agent") {
        throw new Error(`Panel ${id} has an invalid context`);
      }
      for (const location of panel?.locations ?? []) {
        if (location !== "workspace" && location !== "explorer") {
          throw new Error(`Panel ${id} has an invalid location: ${location}`);
        }
      }
      requireFn(panel?.Component, `panel ${id}`);
      summary.push(`addWorkspacePanel(${id})`);
    },
    addCommandCenterItem(item) {
      const id = requireId(item?.id, "Command Center item id");
      requireText(item?.title, `Command Center item ${id} title`);
      requireText(item?.icon, `Command Center item ${id} icon`);
      if (!["global", "workspace", "agent"].includes(item?.context)) {
        throw new Error(`Command Center item ${id} has an invalid context`);
      }
      requireFn(item?.onSelect, `Command Center item ${id} callback`);
      summary.push(`addCommandCenterItem(${id})`);
    },
    addClientSide(contribution) {
      requireFn(contribution, "client-side contribution");
      summary.push("addClientSide()");
    },
    addAttachmentSource(source) {
      summary.push(`addAttachmentSource(${requireId(source?.id, "attachment source id")})`);
    },
    addTheme(theme) {
      summary.push(`addTheme(${requireId(theme?.id, "theme id")})`);
    },
    addTimelineTransformer(transformer) {
      const id = requireId(transformer?.id, "timeline transformer id");
      summary.push(`addTimelineTransformer(${id})`);
    },
    addTimelineRenderer(renderer) {
      const kind = requireId(renderer?.kind, "timeline renderer kind");
      summary.push(`addTimelineRenderer(${kind})`);
    },
    handle() {
      throw new Error("plugin.handle survived into the client bundle");
    },
  };

  const cleanup = contribute(plugin);
  if (typeof cleanup !== "function") throw new Error("contribute() must return a cleanup function");
  for (const { id, surface } of sidebarSurfaces) {
    if (!surfaceIds.has(surface)) {
      throw new Error(`Sidebar item ${id} references a missing surface: ${surface}`);
    }
  }
  await cleanup();
  return summary;
}

async function checkTarget(target) {
  const source = readFileSync(ENTRY, "utf8");
  const { filtered, strippedBindings } = filterEntrypoint(source, target);
  const dangling = findDanglingReferences(filtered, strippedBindings);
  if (dangling.length > 0) {
    for (const { name, from } of dangling) {
      console.error(
        `  ✗ ${target}: "${name}" is used in contribute() but its import ("${from}") is removed from this bundle`,
      );
    }
    return false;
  }

  const built = await esbuild.build(buildOptions(ENTRY, DIR, filtered, target));

  if (target === "server") {
    // Executing the server bundle would start the real scheduler, so stop at a
    // clean build plus the reference check above. check-teardown.mjs runs it.
    console.log(`  ✓ ${target}: builds, no stripped-import references`);
    return true;
  }

  const summary = await runClientBundle(built.outputFiles[0].text);
  if (summary.length === 0) {
    console.error(`  ✗ ${target}: contribute() registered nothing`);
    return false;
  }
  console.log(`  ✓ ${target}: ${summary.join(", ")}`);
  return true;
}

console.log("Checking plugin runtime boundary...");
const results = [];
for (const target of ["client", "server"]) {
  try {
    results.push(await checkTarget(target));
  } catch (error) {
    console.error(`  ✗ ${target}: ${error instanceof Error ? error.message : String(error)}`);
    results.push(false);
  }
}
if (results.includes(false)) {
  console.error("Runtime boundary check failed.");
  process.exitCode = 1;
} else {
  console.log("Runtime boundary OK.");
}
