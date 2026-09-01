/**
 * Shared model of how Paseo compiles a plugin.
 *
 * Mirrors packages/server/src/server/plugins/compiler.ts and
 * plugin-sdk-specifiers.ts. The checks in this repo are only as good as this
 * file, so keep it aligned with the Paseo version in the README's
 * compatibility badge.
 */
import { parse } from "@babel/parser";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Registration calls the compiler deletes from each target's entry point. */
export const REMOVED_REGISTRATIONS = {
  client: new Set(["handle"]),
  server: new Set([
    "addSurface",
    "addSidebarItem",
    "addWorkspacePanel",
    "addCommandCenterItem",
    "addClientSide",
    "addAttachmentSource",
    "addTheme",
    "addTimelineTransformer",
    "addTimelineRenderer",
  ]),
};

/** Specifiers the daemon hands to the plugin's own runtime instead of bundling. */
export const SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/react-native",
];

/** Host modules marked external for the client target. */
export const CLIENT_EXTERNALS = [
  ...SDK_SPECIFIERS,
  "@tanstack/react-query",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
];

/** Host modules marked external for the server target. */
export const SERVER_EXTERNALS = [...SDK_SPECIFIERS, "zod"];

/**
 * Client-only modules the compiler replaces with `{}` in the server bundle
 * rather than resolving from disk.
 */
export const CLIENT_ONLY_MODULES = [
  "@tanstack/react-query",
  "react",
  "react/jsx-runtime",
  "react-native",
  "@getpaseo/plugin/react-native",
];

function exactSpecifierFilter(specifiers) {
  const alternatives = specifiers.map((specifier) =>
    specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^(${alternatives.join("|")})$`);
}

/** esbuild plugin matching createUnusedPlatformModulePlugin for one target. */
export function unusedPlatformModulePlugin(target) {
  const filter = target === "server" ? exactSpecifierFilter(CLIENT_ONLY_MODULES) : /^node:/;
  return {
    name: `paseo-plugin-${target}-unused-platform-modules`,
    setup(build) {
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "paseo-unused-platform-module",
        sideEffects: false,
      }));
      build.onLoad({ filter: /.*/, namespace: "paseo-unused-platform-module" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));
    },
  };
}

export const moduleTarget = (specifier) =>
  /\.client(\.[cm]?[jt]sx?)?$/.test(specifier)
    ? "client"
    : /\.server(\.[cm]?[jt]sx?)?$/.test(specifier)
      ? "server"
      : null;

/**
 * Deletes the other runtime's imports and the registrations that do not apply,
 * leaving every other statement in place — exactly what filterEntrypoint does,
 * and the reason a stripped identifier can dangle.
 */
export function filterEntrypoint(source, target) {
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
export function findDanglingReferences(filtered, strippedBindings) {
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

/** esbuild options matching compileTarget, for a given entry file and target. */
export function buildOptions(entryPath, resolveDir, filteredSource, target) {
  return {
    stdin: {
      contents: filteredSource,
      loader: "tsx",
      resolveDir,
      sourcefile: entryPath,
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    supported: target === "client" ? { "async-await": false } : undefined,
    external: target === "client" ? CLIENT_EXTERNALS : SERVER_EXTERNALS,
    plugins: [unusedPlatformModulePlugin(target)],
    logLevel: "silent",
    treeShaking: true,
  };
}

/**
 * Instantiates a compiled CJS bundle with a caller-supplied module resolver.
 *
 * The bundle is written to a throwaway `.cjs` file and loaded by Node rather
 * than evaluated in-process. Wrapping it as a factory that takes `require` as
 * a parameter shadows Node's own resolver inside the bundle, so every bare
 * specifier still goes through `resolveModule` and an unstubbed one throws --
 * the strictness the checks depend on.
 *
 * Loading a real file also keeps the repository free of `eval`/`new Function`,
 * which the awesome-paseo-plugins security scan treats as a blocking finding
 * even in dev-only tooling that never reaches the daemon.
 */
export function instantiateBundle(code, resolveModule) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-defer-check-"));
  const file = join(directory, "bundle.cjs");
  writeFileSync(
    file,
    `module.exports=(require)=>{const module={exports:{}};const exports=module.exports;${code};return module.exports;};`,
  );
  try {
    return createRequire(import.meta.url)(file)(resolveModule);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
