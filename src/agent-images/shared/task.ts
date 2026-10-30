// Reads the run's task file (src/adapters/agent-runtime/kubernetes/task.ts). The runner checked it
// before the run started; it is checked again here with the same rules, so an image never runs
// on a task its role does not allow. Errors name the problem, never the file's content.
import { readFileSync } from "node:fs";

import type { AgentRole } from "../../adapters/agent-runtime/runtime.ts";
import {
  taskFileJson,
  type AgentTaskFile,
} from "../../adapters/agent-runtime/kubernetes/task.ts";

export type { AgentTaskFile };

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export function parseTask(role: AgentRole, json: string): AgentTaskFile {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TaskError("the task file is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskError("the task file is not a JSON object");
  }
  const task = value as AgentTaskFile;
  try {
    taskFileJson(role, task);
  } catch (error) {
    throw new TaskError(error instanceof Error ? error.message : "the task is invalid");
  }
  return task;
}

export function readTask(role: AgentRole, path: string): AgentTaskFile {
  let json: string;
  try {
    json = readFileSync(path, "utf8");
  } catch {
    throw new TaskError("the task file cannot be read");
  }
  return parseTask(role, json);
}
