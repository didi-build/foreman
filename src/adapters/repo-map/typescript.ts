// Builds the repo map (D-251) with the TypeScript compiler the repository already has. It parses
// each code file on its own (no program, no type check, no module resolution through packages),
// so it reads nothing outside the files it is given and makes no network call. The same files
// give the same map. `readCheckout` reads a checkout already on disk; where the checkout comes
// from is the runner's port (src/core/repo-map.ts `RepoMaps`): GitHub's archive at a commit, read
// with the runner App's `contents: read` token (./github.ts, D-267).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

import type { RepoMap, RepoMapFile } from "../../core/repo-map.ts";

/** The files the compiler parses for exports and imports. */
const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Folders a checkout never maps: version control and installed packages. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

/** A file larger than this is listed but not parsed. */
const MAX_PARSED_BYTES = 1_000_000;

const isCode = (path: string): boolean =>
  CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const hasExport = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const hasDefault = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

function bindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
  }
}

/** The names a file exports and the module specifiers it imports or re-exports from. */
function readSource(
  path: string,
  text: string,
): { exports: string[]; specifiers: string[] } {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(path),
  );
  const exports: string[] = [];
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) exports.push(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        exports.push(clause.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exports.push("default");
      continue;
    }
    if (!hasExport(statement)) continue;
    if (hasDefault(statement)) {
      exports.push("default");
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindingNames(declaration.name, exports);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      exports.push(statement.name.text);
    }
  }
  return { exports, specifiers };
}

/**
 * The repository file a relative specifier names, if any: the path as written, then with a
 * code extension, then a folder's index file. A `.js` specifier also finds its `.ts` source, as
 * TypeScript's own resolution does.
 */
function resolveImport(
  from: string,
  specifier: string,
  paths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (joined.startsWith("../") || joined === "..") return null;
  const candidates = [joined];
  const stem = joined.replace(/\.[mc]?jsx?$/, "");
  for (const ext of CODE_EXTENSIONS) candidates.push(`${stem}${ext}`);
  for (const ext of CODE_EXTENSIONS) candidates.push(`${joined}/index${ext}`);
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

/** The root `package.json` scripts; none when it is missing or is not valid JSON. */
function readScripts(text: string | undefined): Record<string, string> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))
    return {};
  const out: Record<string, string> = {};
  for (const name of Object.keys(scripts).sort()) {
    const value = (scripts as Record<string, unknown>)[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * The map of a checkout's files at `commitSha`: every path, each code file's exports and the
 * repository files it imports, and the root `package.json` scripts. `files` holds each path with
 * its text; a non-code file's text is not read and may be empty.
 */
export function buildRepoMap(
  commitSha: string,
  files: ReadonlyMap<string, string>,
): RepoMap {
  const paths = new Set(files.keys());
  const mapped: RepoMapFile[] = [];
  for (const path of [...paths].sort()) {
    const text = files.get(path) ?? "";
    if (!isCode(path) || text.length > MAX_PARSED_BYTES) {
      mapped.push({ path, exports: [], imports: [] });
      continue;
    }
    const read = readSource(path, text);
    const imports = new Set<string>();
    for (const specifier of read.specifiers) {
      const target = resolveImport(path, specifier, paths);
      if (target !== null && target !== path) imports.add(target);
    }
    mapped.push({
      path,
      exports: [...new Set(read.exports)].sort(),
      imports: [...imports].sort(),
    });
  }
  return { commitSha, files: mapped, scripts: readScripts(files.get("package.json")) };
}

/**
 * Reads a checkout on disk: every regular file under `dir` but `.git` and `node_modules`, with
 * the text of code files and the root `package.json`. Symbolic links are not followed.
 */
export function readCheckout(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string) => {
    const entries = readdirSync(join(dir, relative), { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const wanted =
        (isCode(path) && statSync(join(dir, path)).size <= MAX_PARSED_BYTES) ||
        path === "package.json";
      files.set(path, wanted ? readFileSync(join(dir, path), "utf8") : "");
    }
  };
  walk("");
  return files;
}
