import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  comparePathCodeUnits,
  findConflictMarkers,
  formatConflictMarkerReport,
  isConflictMarkerLine,
  listFilesToScan,
  scanTextForConflictMarkers,
} from "../scripts/check-conflict-markers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliScript = join(root, "scripts/check-conflict-markers.mjs");

function runCli(cwd: string, args: string[] = []) {
  try {
    execFileSync("node", [cliScript, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, stderr: "", stdout: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return {
      status: e.status ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
    };
  }
}

describe("isConflictMarkerLine", () => {
  it("detects opening, closing, and diff3 base markers", () => {
    expect(isConflictMarkerLine("<<<<<<< HEAD")).toBe(true);
    expect(isConflictMarkerLine(">>>>>>> branch-name")).toBe(true);
    expect(isConflictMarkerLine("||||||| base")).toBe(true);
    expect(isConflictMarkerLine("<<<<<<<")).toBe(true);
  });

  it("does not flag equals-only or non-column-0 markers", () => {
    expect(isConflictMarkerLine("=======")).toBe(false);
    expect(isConflictMarkerLine("  <<<<<<< HEAD")).toBe(false);
    expect(isConflictMarkerLine('code = "<<<<<<< HEAD"')).toBe(false);
  });

  it("does not flag eight-marker prefixes or seven markers without a space", () => {
    expect(isConflictMarkerLine("<<<<<<<< x")).toBe(false);
    expect(isConflictMarkerLine(">>>>>>>> x")).toBe(false);
    expect(isConflictMarkerLine("|||||||| x")).toBe(false);
    expect(isConflictMarkerLine("<<<<<<<HEAD")).toBe(false);
  });
});

describe("scanTextForConflictMarkers", () => {
  it("reports correct line numbers", () => {
    const text = "ok\n<<<<<<< HEAD\nmiddle\n>>>>>>> other\n";
    expect(scanTextForConflictMarkers(text)).toEqual([
      { line: 2, text: "<<<<<<< HEAD" },
      { line: 4, text: ">>>>>>> other" },
    ]);
  });

  it("handles CRLF line endings", () => {
    const text = "a\r\n<<<<<<< HEAD\r\nb\r\n";
    expect(scanTextForConflictMarkers(text)).toEqual([
      { line: 2, text: "<<<<<<< HEAD" },
    ]);
  });

  it("flags a bare opening marker as the last line without a trailing newline", () => {
    expect(scanTextForConflictMarkers("ok\n<<<<<<<")).toEqual([
      { line: 2, text: "<<<<<<<" },
    ]);
  });
});

describe("comparePathCodeUnits", () => {
  it("sorts by UTF-16 code units, not locale collation", () => {
    const names = ["B.md", "a.md", "é.md"];
    names.sort(comparePathCodeUnits);
    expect(names).toEqual(["B.md", "a.md", "é.md"]);
  });
});

describe("findConflictMarkers (unit)", () => {
  it("detects markers across files in deterministic code-unit order", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-"));
    writeFileSync(join(dir, "é.md"), ">>>>>>> z\n");
    writeFileSync(join(dir, "B.md"), ">>>>>>> z\n");
    writeFileSync(join(dir, "a.txt"), "<<<<<<< HEAD\n");
    const { hits } = findConflictMarkers(dir);
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      "B.md:1",
      "a.txt:1",
      "é.md:1",
    ]);
  });

  it("does not flag setext headings, indented markers, or in-string examples", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-fp-"));
    writeFileSync(
      join(dir, "doc.md"),
      'Title\n=======\n\n  <<<<<<< HEAD\nconst s = "<<<<<<< HEAD\\n";\n',
    );
    expect(findConflictMarkers(dir).hits).toEqual([]);
  });

  it("does not flag a marker in the middle of a line", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-mid-"));
    writeFileSync(join(dir, "x.txt"), "text <<<<<<< HEAD\n");
    expect(findConflictMarkers(dir).hits).toEqual([]);
  });

  it("skips binary files that contain both a NUL byte and a marker (non-git walk)", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-skip-"));
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "x.txt"), "<<<<<<< HEAD\n");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "<<<<<<< HEAD\n");
    writeFileSync(
      join(dir, "binary.bin"),
      Buffer.concat([
        Buffer.from("<<<<<<< HEAD\n"),
        Buffer.from([0x00]),
        Buffer.from("tail"),
      ]),
    );
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    big.write("<<<<<<< HEAD\n", 0);
    writeFileSync(join(dir, "big.txt"), big);
    writeFileSync(join(dir, "clean.txt"), "ok\n");
    expect(findConflictMarkers(dir).hits).toEqual([]);
  });

  it("includes package-lock.json when it contains markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-lock-"));
    writeFileSync(join(dir, "package-lock.json"), "<<<<<<< HEAD\n");
    const { hits } = findConflictMarkers(dir);
    expect(hits).toEqual([
      { path: "package-lock.json", line: 1, text: "<<<<<<< HEAD" },
    ]);
  });

  it("reports cannot read when a staged path is not readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-eacces-"));
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "<<<<<<< HEAD\n");
    const readFile = ((path, ...args) => {
      if (path === secret) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return readFileSync(path, ...args);
    }) as typeof readFileSync;
    const { hits, errors } = findConflictMarkers(dir, ["secret.txt"], { readFile });
    expect(hits).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("secret.txt");
    expect(errors[0].message).toMatch(/EACCES|permission denied/i);
  });

  it("reports marker hits and read errors together", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-mixed-"));
    writeFileSync(join(dir, "marked.txt"), "<<<<<<< HEAD\n");
    const blocked = join(dir, "blocked.txt");
    writeFileSync(blocked, "clean\n");
    const readFile = ((path, ...args) => {
      if (path === blocked) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return readFileSync(path, ...args);
    }) as typeof readFileSync;
    const { hits, errors } = findConflictMarkers(dir, ["marked.txt", "blocked.txt"], {
      readFile,
    });
    expect(hits).toEqual([{ path: "marked.txt", line: 1, text: "<<<<<<< HEAD" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("blocked.txt");
  });
});

describe("findConflictMarkers (git)", () => {
  it("reports untracked non-ignored files and ignores gitignored files", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-git-"));
    execFileSync("git", ["init"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "<<<<<<< HEAD\n");
    writeFileSync(join(dir, "tracked.txt"), "clean\n");
    writeFileSync(join(dir, "untracked.txt"), "||||||| base\n");
    const { hits } = findConflictMarkers(dir);
    expect(hits).toEqual([{ path: "untracked.txt", line: 1, text: "||||||| base" }]);
  });

  it("reports conflict markers in non-ASCII file and directory names", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-unicode-"));
    execFileSync("git", ["init"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "ignoré.txt\n");
    writeFileSync(join(dir, "ignoré.txt"), "<<<<<<< HEAD\n");
    writeFileSync(join(dir, "café.md"), "<<<<<<< HEAD\n");
    mkdirSync(join(dir, "dir é"), { recursive: true });
    writeFileSync(join(dir, "dir é", "x.md"), "<<<<<<< HEAD\n");
    writeFileSync(join(dir, "日本語.txt"), "<<<<<<< HEAD\n");
    execFileSync("git", ["add", "日本語.txt"], { cwd: dir });
    writeFileSync(join(dir, "has space.md"), "<<<<<<< HEAD\n");
    writeFileSync(join(dir, 'quote".md'), "<<<<<<< HEAD\n");
    const { hits } = findConflictMarkers(dir);
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      "café.md:1",
      "dir é/x.md:1",
      "has space.md:1",
      'quote".md:1',
      "日本語.txt:1",
    ]);
  });

  it("skips binary git-tracked files that contain a NUL byte and a marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-git-bin-"));
    execFileSync("git", ["init"], { cwd: dir });
    writeFileSync(
      join(dir, "binary.bin"),
      Buffer.concat([
        Buffer.from("<<<<<<< HEAD\n"),
        Buffer.from([0x00]),
        Buffer.from("x"),
      ]),
    );
    execFileSync("git", ["add", "binary.bin"], { cwd: dir });
    expect(findConflictMarkers(dir).hits).toEqual([]);
  });
});

describe("listFilesToScan", () => {
  it("uses git ls-files inside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-list-"));
    execFileSync("git", ["init"], { cwd: dir });
    writeFileSync(join(dir, "only.txt"), "x\n");
    expect(listFilesToScan(dir)).toContain("only.txt");
  });
});

describe("check-conflict-markers CLI (subprocess)", () => {
  it("exits 0 with no output when clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-cli-clean-"));
    writeFileSync(join(dir, "ok.txt"), "hello\n");
    const result = runCli(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });

  it("exits 1 with path:line output and instruction when dirty", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-cli-dirty-"));
    writeFileSync(join(dir, "readme.md"), "<<<<<<< HEAD\n");
    const result = runCli(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("readme.md:1: <<<<<<< HEAD");
    expect(result.stderr).toContain("npm run conflict-markers");
  });

  it("checks only file arguments when provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "conflict-markers-cli-args-"));
    writeFileSync(join(dir, "bad.md"), "<<<<<<< HEAD\n");
    writeFileSync(join(dir, "good.md"), "clean\n");
    const result = runCli(dir, ["good.md"]);
    expect(result.status).toBe(0);
    const onlyBad = runCli(dir, ["bad.md"]);
    expect(onlyBad.status).toBe(1);
  });

  // Root can still read mode 0o000; on Windows chmod does not remove read permission.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "exits 1 with cannot read when a file is not readable",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "conflict-markers-cli-eacces-"));
      const secret = join(dir, "nope.txt");
      writeFileSync(secret, "x\n");
      chmodSync(secret, 0o000);
      try {
        const result = runCli(dir, ["nope.txt"]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("nope.txt: cannot read:");
      } finally {
        chmodSync(secret, 0o600);
      }
    },
  );
});

describe("formatConflictMarkerReport", () => {
  it("trims marker lines to 80 characters", () => {
    const long = "<<<<<<< " + "x".repeat(100);
    const report = formatConflictMarkerReport([{ path: "f.txt", line: 1, text: long }]);
    const firstLine = report.split("\n")[0];
    expect(firstLine.length).toBeLessThanOrEqual("f.txt:1: ".length + 80);
  });
});
