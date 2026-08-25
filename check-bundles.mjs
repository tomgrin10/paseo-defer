/**
 * Guards the plugin runtime boundary, which typecheck cannot see.
 *
 * Paseo compiles index.ts twice. For each target it deletes the other runtime's
 * imports and the registration calls that do not apply, but leaves every other
 * statement in place. So a server identifier used anywhere in contribute()'s
 * shared body survives with its import gone and throws a ReferenceError at
 * load, which silently drops every contribution.
 *
 * Mirrors filterEntrypoint() in packages/server/src/server/plugins/compiler.ts.
 */
import { parse } from "@babel/parser";
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, "index.ts");
const REMOVED_REGISTRATIONS = {
  client: new Set(["handle"]),
  server: new Set([
    "addSurface",
    "addSidebarItem",
    "addWorkspacePanel",
    "addCommandCenterItem",
    "addAttachmentSource",
    "addTheme",
  ]),
};

const moduleTarget = (specifier) =>
  /\.client(\.[cm]?[jt]sx?)?$/.test(specifier)
    ? "client"
    : /\.server(\.[cm]?[jt]sx?)?$/.test(specifier)
      ? "server"
      : null;

function filterEntrypoint(source, target) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const fn = ast.program.body.find((node) => node.type === "ExportDefaultDeclaration")?.declaration;
  if (!fn?.params?.[0]?.name) throw new Error("index.ts must default-export contribute(plugin)");
  const contextName = fn.params[0].name;
  const ranges = [];

  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ExpressionStatement" && node.expression?.type === "CallExpression") {
      const callee = node.expression.callee;
      if (
        callee?.type === "MemberExpression" &&
        callee.object?.name === contextName &&
        REMOVED_REGISTRATIONS[target].has(callee.property?.name)
      ) {
        ranges.push({ start: node.start, end: node.end });
        return;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  })(fn.body);

  const strippedBindings = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const importedTarget = moduleTarget(statement.source.value);
    if (importedTarget === null || importedTarget === target) continue;
    ranges.push({ start: statement.start, end: statement.end });
    for (const specifier of statement.specifiers) {
      // Type-only imports vanish at compile time and cannot dangle.
      if (specifier.importKind === "type" || statement.importKind === "type") continue;
      strippedBindings.push({ name: specifier.local.name, from: statement.source.value });
    }
  }

  let filtered = source;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    filtered = filtered.slice(0, range.start) + filtered.slice(range.end);
  }
  return { filtered, strippedBindings };
}

/** Any stripped binding still referenced after filtering is a load-time crash. */
function findDanglingReferences(filtered, strippedBindings) {
  const ast = parse(filtered, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const used = new Set();
  (function walk(node, parent) {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier" && parent?.type !== "ImportSpecifier") used.add(node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => walk(child, node));
      else if (value && typeof value === "object") walk(value, node);
    }
  })(ast.program, null);
  return strippedBindings.filter((binding) => used.has(binding.name));
}

const EXTERNAL = [
  "react",
  "react/jsx-runtime",
  "react-native",
  "@tanstack/react-query",
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
];

async function checkTarget(target) {
  const { filtered, strippedBindings } = filterEntrypoint(readFileSync(ENTRY, "utf8"), target);
  const dangling = findDanglingReferences(filtered, strippedBindings);
  if (dangling.length > 0) {
    for (const { name, from } of dangling) {
      console.error(
        `  ✗ ${target}: "${name}" is used in contribute() but its import ("${from}") is removed from this bundle`,
      );
    }
    return false;
  }

  const probe = resolve(DIR, `.check-${target}.entry.tsx`);
  writeFileSync(probe, filtered);
  try {
    const built = await esbuild.build({
      entryPoints: [probe],
      bundle: true,
      write: false,
      format: "cjs",
      platform: target === "server" ? "node" : "neutral",
      target: target === "server" ? "node20" : "es2020",
      external: target === "server" ? EXTERNAL.filter((id) => !id.startsWith("react")) : EXTERNAL,
      absWorkingDir: DIR,
      logLevel: "silent",
    });

    if (target === "server") {
      // Executing the server bundle would start the real scheduler, so stop at
      // a clean build plus the reference check above.
      console.log(`  ✓ ${target}: builds, no stripped-import references`);
      return true;
    }

    const zod = await import("zod");
    const stubs = {
      zod,
      react: {},
      "react/jsx-runtime": {},
      "react-native": {},
      "@tanstack/react-query": {},
      "@getpaseo/plugin": {},
      "@getpaseo/plugin/server": { defineRpc: (d) => d, defineAttachmentSource: (d) => d },
    };
    const factory = new Function(
      "require",
      `const module={exports:{}};const exports=module.exports;${built.outputFiles[0].text};return module.exports;`,
    );
    const registered = [];
    const plugin = new Proxy(
      {},
      {
        get: (_target, name) => (...args) => {
          registered.push(`${String(name)}(${args?.[0]?.id ?? args?.[0]?.name ?? args?.[0] ?? ""})`);
        },
      },
    );
    const cleanup = factory((id) => stubs[id] ?? {}).default(plugin);
    if (typeof cleanup === "function") await cleanup();
    if (registered.length === 0) {
      console.error(`  ✗ ${target}: contribute() registered nothing`);
      return false;
    }
    console.log(`  ✓ ${target}: ${registered.join(", ")}`);
    return true;
  } finally {
    rmSync(probe, { force: true });
  }
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
