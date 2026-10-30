// QA's read-only file tool over the fetched tree (ADR 0112: read, search and list; no shell, no
// edits, no running repository code). The tree is mounted read-only; these tools add a second
// fence: paths stay inside the tree (no `..`, no absolute paths, no symbolic link out of it),
// `.git` is never read, and every file read is logged with its path and content hash.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";

const MAX_READ_BYTES = 100 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_QUERY = 200;

export interface ToolOutput {
  content: string;
  isError: boolean;
}

/** One line per read file: its path and content hash (ADR 0112). Never its content. */
export interface FileReadLog {
  event: "qa_file_read";
  path: string;
  sha256: string;
  bytes: number;
}

export class ToolInputError extends Error {}

/** The tool definitions, in a fixed order so the cached prefix never changes (D-185). */
export const WORKSPACE_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description:
      'List the files and folders in one folder of the repository at the head commit. Folders end with /. Use "." for the root.',
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "A folder path relative to the root." },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read one file of the repository at the head commit. Each line starts with its line number, for citing findings.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "A file path relative to the root." },
      },
    },
  },
  {
    name: "search_files",
    description:
      "Find lines that contain a literal text (not a pattern) in the files under a folder. Returns path:line: text for each match.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query", "path"],
      properties: {
        query: { type: "string", description: "The literal text to find." },
        path: {
          type: "string",
          description: 'A folder path relative to the root. "." for all.',
        },
      },
    },
  },
];

function stringField(input: unknown, name: string): string {
  const value =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)[name]
      : undefined;
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string`);
  return value;
}

export interface Workspace {
  run(name: string, input: unknown): Promise<ToolOutput>;
}

export function createWorkspace(
  root: string,
  log: (entry: FileReadLog) => void,
): Workspace {
  let rootReal: Promise<string> | undefined;
  const realRoot = () => (rootReal ??= realpath(root));

  /** A path inside the tree, or an error. Returns the relative and the real absolute path. */
  async function resolveInside(
    raw: string,
  ): Promise<{ relative: string; real: string }> {
    if (raw.includes("\0") || raw.startsWith("/") || raw.startsWith("\\")) {
      throw new ToolInputError("the path must be relative to the repository root");
    }
    const relative = normalize(raw === "" ? "." : raw).replace(/\/+$/, "") || ".";
    const parts = relative.split(sep);
    if (parts.includes(".."))
      throw new ToolInputError("the path must stay inside the repository");
    if (parts.includes(".git")) throw new ToolInputError(".git is not readable");
    const base = await realRoot();
    let real: string;
    try {
      real = await realpath(join(base, relative));
    } catch {
      throw new ToolInputError("no such file or folder");
    }
    if (real !== base && !real.startsWith(base + sep)) {
      throw new ToolInputError("the path must stay inside the repository");
    }
    return { relative, real };
  }

  async function listFiles(input: unknown): Promise<string> {
    const { real } = await resolveInside(stringField(input, "path"));
    if (!(await stat(real)).isDirectory()) throw new ToolInputError("not a folder");
    const entries = (await readdir(real, { withFileTypes: true }))
      .filter((e) => e.name !== ".git")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const more = entries.length - shown.length;
    return (
      [...shown, ...(more > 0 ? [`(${more} more not shown)`] : [])].join("\n") ||
      "(empty)"
    );
  }

  async function readOne(input: unknown): Promise<string> {
    const { relative, real } = await resolveInside(stringField(input, "path"));
    const info = await stat(real);
    if (!info.isFile()) throw new ToolInputError("not a file");
    const bytes = await readFile(real);
    log({
      event: "qa_file_read",
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    if (bytes.includes(0)) return "(binary file, not shown)";
    const shown = bytes.subarray(0, MAX_READ_BYTES).toString("utf8");
    const numbered = shown
      .split("\n")
      .map((line, i) => `${i + 1}: ${line}`)
      .join("\n");
    return bytes.length > MAX_READ_BYTES
      ? `${numbered}\n(file cut at ${MAX_READ_BYTES} bytes of ${bytes.length})`
      : numbered;
  }

  async function search(input: unknown): Promise<string> {
    const query = stringField(input, "query");
    if (query === "" || query.length > MAX_QUERY) {
      throw new ToolInputError(`query must be 1 to ${MAX_QUERY} characters`);
    }
    const { relative, real } = await resolveInside(stringField(input, "path"));
    const base = await realRoot();
    const matches: string[] = [];
    let files = 0;
    const walk = async (dir: string, shown: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_MATCHES || files >= MAX_SEARCH_FILES) return;
        if (entry.name === ".git" || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        const name = shown === "." ? entry.name : `${shown}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(path, name);
          continue;
        }
        if (!entry.isFile()) continue;
        files += 1;
        if ((await stat(path)).size > MAX_SEARCH_FILE_BYTES) continue;
        const bytes = await readFile(path);
        if (bytes.includes(0)) continue;
        const lines = bytes.toString("utf8").split("\n");
        for (
          let i = 0;
          i < lines.length && matches.length < MAX_SEARCH_MATCHES;
          i += 1
        ) {
          if ((lines[i] as string).includes(query)) {
            matches.push(`${name}:${i + 1}: ${(lines[i] as string).slice(0, 300)}`);
          }
        }
      }
    };
    if (!real.startsWith(base))
      throw new ToolInputError("the path must stay inside the repository");
    if (!(await stat(real)).isDirectory()) throw new ToolInputError("not a folder");
    await walk(real, relative);
    return matches.length === 0 ? "(no matches)" : matches.join("\n");
  }

  const handlers: Record<string, (input: unknown) => Promise<string>> = {
    list_files: listFiles,
    read_file: readOne,
    search_files: search,
  };

  return {
    async run(name, input) {
      const handler = handlers[name];
      if (handler === undefined)
        return { content: `unknown tool ${name}`, isError: true };
      try {
        return { content: await handler(input), isError: false };
      } catch (error) {
        return {
          content: error instanceof ToolInputError ? error.message : "the tool failed",
          isError: true,
        };
      }
    },
  };
}
