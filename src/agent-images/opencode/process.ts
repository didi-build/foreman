// Runs OpenCode as a child process (D-172): by its path, with an argument list, `shell: false` and
// the command's environment only. The prompt is written to stdin and stdin is closed, since
// OpenCode reads all of it before it starts. Each stdout line is handed to `onLine` as it
// arrives; when `onLine` asks to stop, the child gets SIGTERM and, if it is still running after
// the grace period, SIGKILL. SIGTERM from Kubernetes (deadline, cancel) is passed on the same way.
// stderr is never read: it may hold the agent's text.
import { spawn } from "node:child_process";

import type { OpenCodeCommand } from "./command.ts";

/** One event line is small; a longer one (a huge tool output) is dropped, not buffered. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** How long OpenCode has between SIGTERM and SIGKILL, inside the pod's own grace period. */
export const STOP_GRACE_MS = 10_000;

/** The timer the grace period runs on. Tests pass a fake one. */
export interface StopClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: StopClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ChildEnd {
  exitCode: number | null;
  /** True when the wrapper (or the pod's SIGTERM) stopped the child. */
  stopped: boolean;
}

export function runOpenCode(
  command: OpenCodeCommand,
  input: string,
  onLine: (line: string) => "stop" | void,
  clock: StopClock = SYSTEM_CLOCK,
  graceMs: number = STOP_GRACE_MS,
): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stopped = false;
    let killTimer: unknown = null;
    let closed = false;
    const stop = () => {
      if (stopped || closed) return;
      stopped = true;
      child.kill("SIGTERM");
      killTimer = clock.setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, graceMs);
    };

    let pending: Buffer[] = [];
    let pendingSize = 0;
    let dropping = false;
    const emit = (line: string) => {
      if (stopped) return;
      if (onLine(line) === "stop") stop();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
        if (!dropping) {
          pending.push(chunk.subarray(start, i));
          emit(Buffer.concat(pending).toString("utf8"));
        }
        pending = [];
        pendingSize = 0;
        dropping = false;
        start = i + 1;
      }
      if (start < chunk.length && !dropping) {
        pending.push(chunk.subarray(start));
        pendingSize += chunk.length - start;
        if (pendingSize > MAX_LINE_BYTES) {
          pending = [];
          pendingSize = 0;
          dropping = true;
        }
      }
    });

    // OpenCode may exit before it reads all of stdin; that is its answer, not a wrapper error.
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");

    process.once("SIGTERM", stop);
    child.once("error", (error) => {
      closed = true;
      process.removeListener("SIGTERM", stop);
      if (killTimer !== null) clock.clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      closed = true;
      process.removeListener("SIGTERM", stop);
      if (killTimer !== null) clock.clearTimeout(killTimer);
      if (!dropping && pendingSize > 0) emit(Buffer.concat(pending).toString("utf8"));
      resolve({ exitCode: code, stopped });
    });
  });
}
