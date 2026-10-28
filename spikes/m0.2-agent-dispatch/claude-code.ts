// M0.2 spike (V-01 path for the Developer): can the runner start Claude Code without a person
// and read its final result? Docs: https://code.claude.com/docs/en/headless
//
// Needs: the `claude` CLI on PATH, ANTHROPIC_API_KEY, and SCRATCH_REPO_DIR (a clone of a
// throwaway repo, never a real project). The scratch repo must contain a .foreman-scratch file, so the
// spike cannot run against a real project by mistake. Run: node spikes/m0.2-agent-dispatch/claude-code.ts
// Unverified until the run: the --bare flag, taken from the headless docs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allowListedEnv,
  BASE_PROCESS_ENV,
  isEntryPoint,
  minutes,
  printRecord,
  requireEnv,
  runProcess,
  truncate,
  type RunRecord,
} from "../lib/spike.ts";

/** A file that marks a clone as a throwaway scratch repo. */
export const SCRATCH_MARKER = ".foreman-scratch";
const EXPECTED_FILE = "SPIKE_CLAUDE_CODE.md";
const EXPECTED_TEXT = "hello from the claude code spike";
const TASK = `Create a file named ${EXPECTED_FILE} in the repository root containing exactly the line "${EXPECTED_TEXT}". Do not commit, push or change anything else.`;

/** Map the `--output-format json` result object to the spike record fields. */
export function parseClaudeResult(
  stdout: string,
): Pick<RunRecord, "status" | "finalText" | "turns" | "costUsd"> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { status: "error", finalText: truncate(stdout) };
  }
  const subtype = String(parsed.subtype ?? "");
  const status: RunRecord["status"] =
    subtype === "success" && parsed.is_error !== true
      ? "success"
      : subtype === "error_max_turns"
        ? "max_turns"
        : subtype === "error_max_budget_usd"
          ? "budget"
          : "error";
  return {
    status,
    finalText: truncate(
      typeof parsed.result === "string"
        ? parsed.result
        : JSON.stringify(parsed.errors ?? parsed),
    ),
    turns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
    costUsd:
      typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
  };
}

async function main(): Promise<void> {
  const env = requireEnv(["ANTHROPIC_API_KEY", "SCRATCH_REPO_DIR"]);
  if (!existsSync(join(env.SCRATCH_REPO_DIR, SCRATCH_MARKER))) {
    console.error(
      `Refusing to run: ${SCRATCH_MARKER} not found in SCRATCH_REPO_DIR. Add it to the scratch repo only.`,
    );
    process.exit(3);
  }
  const startedAt = new Date().toISOString();
  const run = await runProcess(
    "claude",
    [
      "--bare",
      "-p",
      TASK,
      "--output-format",
      "json",
      "--max-turns",
      "10",
      "--max-budget-usd",
      "1",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Write,Edit",
    ],
    {
      cwd: env.SCRATCH_REPO_DIR,
      timeoutMs: minutes(10),
      // The agent sees only what it needs: not the rest of your shell's variables.
      env: allowListedEnv([...BASE_PROCESS_ENV, "ANTHROPIC_API_KEY"]),
    },
  );
  const parsed = parseClaudeResult(run.stdout);
  // Evidence from outside the agent: check the file ourselves instead of trusting the report.
  const filePath = join(env.SCRATCH_REPO_DIR, EXPECTED_FILE);
  const fileOk =
    existsSync(filePath) && readFileSync(filePath, "utf8").includes(EXPECTED_TEXT);
  const record: RunRecord = {
    spike: "M0.2",
    runtime: "claude_code_cli",
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: run.exitCode,
    ...parsed,
    status: run.timedOut ? "timeout" : parsed.status,
    notes: [
      `Independent check: ${EXPECTED_FILE} ${fileOk ? "exists with the expected text" : "is missing or wrong"}.`,
      ...(run.stderr ? [`stderr: ${truncate(run.stderr, 1000)}`] : []),
    ],
  };
  printRecord(record, [env.ANTHROPIC_API_KEY]);
  process.exitCode = record.status === "success" && fileOk ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) await main();
