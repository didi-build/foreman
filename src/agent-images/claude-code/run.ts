// Runs the CLI as a child process: by its path, with an argument list and `shell: false`, and an
// allow-listed environment (D-172). SIGTERM from Kubernetes (deadline, cancel) is passed on, so the
// CLI stops inside the grace period. Its stderr is never printed: it may hold the agent's text.
import { spawn } from "node:child_process";

import type { ClaudeCommand } from "./args.ts";

/** Claude Code's JSON result is small; this caps memory if the CLI misbehaves. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export interface CliRun {
  stdout: string;
  exitCode: number | null;
}

export function runCli(command: ClaudeCommand): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    const forward = () => child.kill("SIGTERM");
    process.once("SIGTERM", forward);
    child.once("error", (error) => {
      process.removeListener("SIGTERM", forward);
      reject(error);
    });
    child.once("close", (code) => {
      process.removeListener("SIGTERM", forward);
      resolve({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code });
    });
  });
}
