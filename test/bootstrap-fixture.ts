// Shared fakes for the Bootstrap tests (D-358 lock 1, O-113): a hermetic environment for git and
// node subprocesses, a fake GitHub API (in process, and for subprocesses through
// test/fixtures/bootstrap/fake-github.mjs), throwaway git repositories and a reader for
// GITHUB_OUTPUT. No real GitHub, token or network is used; every token below is made up.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const scriptsDir = join(repoRoot, ".github/scripts");
export const fakeGithubModule = join(
  repoRoot,
  "test/fixtures/bootstrap/fake-github.mjs",
);

export const FAKE_TOKEN = "fake-bootstrap-pat-for-isolation-tests";
export const FAKE_TOKEN_BASIC_B64 = Buffer.from(
  `x-access-token:${FAKE_TOKEN}`,
).toString("base64");

export type GithubAnswer = { status: number; body?: unknown } | { noAnswer: true };
export type GithubRequest = {
  key: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | null;
};

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * The parent environment without anything a runner or this machine sets for git, GitHub or
 * tokens, and with no global or system git config.
 */
export function hermeticEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("GIT_") ||
      key.startsWith("GITHUB_") ||
      key.startsWith("RUNNER_") ||
      key.startsWith("LAUNCHPAD_") ||
      ["GH_TOKEN", "BOOTSTRAP_TOKEN", "NODE_OPTIONS", "HAS_BOOTSTRAP_TOKEN"].includes(
        key,
      )
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

export function git(dir: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir, encoding: "utf8", env },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Makes dir a git repository with one commit of its current files. */
export function commitAll(
  dir: string,
  env: NodeJS.ProcessEnv,
  message = "Initial commit",
) {
  if (!existsSync(join(dir, ".git"))) git(dir, ["init", "-q", "-b", "main"], env);
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message], env);
  return git(dir, ["rev-parse", "HEAD"], env);
}

/** Writes the answers file and returns the env that loads the fake GitHub into node. */
export function fakeGithubEnv(dir: string, answers: Record<string, GithubAnswer>) {
  const answersPath = join(dir, ".fake-github-answers.json");
  const logPath = join(dir, ".fake-github-log.jsonl");
  writeFileSync(answersPath, JSON.stringify(answers));
  writeFileSync(logPath, "");
  return {
    env: {
      NODE_OPTIONS: `--import ${fakeGithubModule}`,
      FAKE_GITHUB_ANSWERS: answersPath,
      FAKE_GITHUB_LOG: logPath,
    },
    requests: (): GithubRequest[] =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GithubRequest),
  };
}

/** An in-process fake fetch with the same answers. */
export function fakeFetch(answers: Record<string, GithubAnswer>) {
  const requests: GithubRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    requests.push({
      key,
      url: url.href,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
      redirect: init?.redirect ?? null,
    });
    const answer = answers[key];
    if (!answer)
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if ("noAnswer" in answer) throw new TypeError("fetch failed");
    return new Response(
      answer.body === undefined ? null : JSON.stringify(answer.body),
      {
        status: answer.status,
      },
    );
  };
  return { fetchImpl, requests };
}

/** Reads a GITHUB_OUTPUT file, both `key=value` and the delimiter form. */
export function parseGithubOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heredoc = line.match(/^([A-Za-z0-9_-]+)<<(\S+)$/);
    if (heredoc) {
      const value: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== heredoc[2]) {
        value.push(lines[i]);
        i += 1;
      }
      out[heredoc[1]] = value.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Runs one of the protected scripts with node, as the workflow does. */
export function runScript(
  script: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const files = tempDir("bootstrap-step-files-");
  const outputPath = join(files, "github-output");
  const summaryPath = join(files, "github-step-summary");
  writeFileSync(outputPath, "");
  writeFileSync(summaryPath, "");
  try {
    const result = spawnSync(process.execPath, [join(scriptsDir, script), ...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        ...options.env,
      },
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      output: parseGithubOutput(readFileSync(outputPath, "utf8")),
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(files, { recursive: true, force: true });
  }
}
