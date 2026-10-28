// Shared helpers for the Milestone 0 spikes. Throwaway code: see docs/spikes/README.md.
// Rules: credentials come only from environment variables, values are never printed,
// and every run ends with one JSON record on stdout.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What every dispatch spike reports. Mirrors the adapter result proposed for ADR 0107. */
export interface RunRecord {
  spike: string;
  runtime: string;
  startedAt: string;
  endedAt: string;
  status: "success" | "max_turns" | "budget" | "error" | "timeout";
  exitCode: number | null;
  finalText: string;
  structured?: unknown;
  turns?: number;
  costUsd?: number;
  notes?: string[];
}

/** Exit code used when the spike cannot run because a credential or setting is missing. */
export const MISSING_SETTING_EXIT = 2;

/**
 * Read required environment variables. If any are missing, print their names
 * (never values) and exit with MISSING_SETTING_EXIT.
 */
export function requireEnv<const Name extends string>(
  names: readonly Name[],
  env: NodeJS.ProcessEnv = process.env,
): Record<Name, string> {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(
      `Missing settings: ${missing.join(", ")}. Set them as environment variables and run again.`,
    );
    process.exit(MISSING_SETTING_EXIT);
  }
  return Object.fromEntries(names.map((name) => [name, env[name] as string])) as Record<
    Name,
    string
  >;
}

/** Replace every occurrence of each secret in `text` with a marker. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= 8)
    .reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/** Keep the record readable: long agent output is cut, not dropped. */
export function truncate(text: string, max = 4000): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`;
}

export function printRecord(record: RunRecord, secrets: readonly string[]): void {
  console.log(redact(JSON.stringify(record, null, 2), secrets));
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command with a wall-clock limit. The runner enforces time from outside the agent. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    // Windows (Git Bash) needs a shell to find .cmd shims such as claude.cmd.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      stderr += String(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

/** POST JSON with a timeout. Returns status and parsed body (or raw text when not JSON). */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await readBody(response) };
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await readBody(response) };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function minutes(n: number): number {
  return n * 60_000;
}

/** True when the module at `moduleUrl` is the script node was started with (works on every Node 22). */
export function isEntryPoint(moduleUrl: string): boolean {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(moduleUrl)
  );
}
