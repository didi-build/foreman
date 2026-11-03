// What the runner hands an agent image besides its settings (ADR 0106, ADR 0107): the run's task
// file. It is the per-run text (the role's instructions from the bot file and the run's input)
// and the few role facts that are not limits, models or addresses. The runner builds it, writes
// it into a per-run Secret mounted read-only into the agent pod only, and deletes it with the run.
// The image reads it from FOREMAN_TASK_FILE (src/agent-images/shared/task.ts).
//
// It is a file, not an environment variable, because one Linux variable is capped at 128 KiB and
// QA's input (the diff and its context) can be larger. A Secret, not a ConfigMap, because the
// runner's Role can already create and delete Secrets by name (ADR 0106 section 1), so its rights
// do not grow, and the input may hold private repository text.
import type { AgentRole } from "../runtime.ts";

/** Version 1 of the task file. */
export interface AgentTaskFile {
  foremanTask: 1;
  /** The role's instructions, from the bot file. Stable across runs: the cached prefix. */
  instructions: string;
  /** This run's input. Treated as data, never as instructions. */
  input: string;
  /** Developer and Designer: the Claude Code tools the run may use, from the bot file. */
  allowedTools?: string[];
  /**
   * QA: the node the verdict is for. Developer and Designer: the node the run works on, which
   * the OpenCode image's wrapper names when it posts the run's docs note (N-44, D-235).
   */
  nodeId?: string;
  /**
   * Developer and Designer: the branch the run pushes to (`runBranch` in src/core/task-input.ts).
   * The OpenCode image's wrapper opens or reuses the pull request for it (N-44, D-235).
   */
  branch?: string;
  /** QA: the runner's evidence ids the verdict may cite (ADR 0107). */
  evidenceIds?: string[];
  /**
   * Council and Triage, and QA's visual comparison: the JSON schema of the structured result,
   * from the bot file.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * QA's visual comparison (D-242): the image pairs the runner made, in order, each with the
   * runner's own label. A QA task with images carries the answer schema and no evidence ids,
   * and its image posts nothing: the runner records the answer. The Council's call on a visual
   * approval (D-270): the option screenshots, one per option, each with the runner's own label.
   */
  images?: TaskImage[];
}

/** The roles whose task may carry images: QA's visual comparison and the Council's visual call. */
const IMAGE_ROLES: readonly AgentRole[] = ["qa", "council"];

/** One PNG for a visual comparison or visual call run, base64 encoded. */
export interface TaskImage {
  label: string;
  mediaType: "image/png";
  data: string;
}

/** At most 20 pairs: an approved crop and a built crop each. */
export const MAX_TASK_IMAGES = 40;
const LABEL = /^[A-Za-z0-9 ,.:()_-]{1,200}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Where the agent pod finds its task file. */
export const TASK_MOUNT_PATH = "/task";
export const TASK_FILE_KEY = "task.json";
export const TASK_FILE_PATH = `${TASK_MOUNT_PATH}/${TASK_FILE_KEY}`;

/** A Secret holds at most 1 MiB; keep room for its metadata. */
export const MAX_TASK_BYTES = 900 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One allowed tool: a name, optionally with a pattern, for example `Bash(git *)` (D-196). */
export const TOOL = /^[A-Za-z][A-Za-z0-9_]*(?:\([^()\n]{1,200}\))?$/;
/**
 * A branch name the wrapper may use in a GitHub API path: plain segments of letters, digits,
 * `.`, `_` and `-` joined by `/`, none starting with `.` or `-`, so never `..` or an option.
 */
export const BRANCH =
  /^(?=.{1,200}$)[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a task for its role before anything is created. Errors name the field, never its value.
 * Returns the file's exact text.
 */
export function taskFileJson(role: AgentRole, task: AgentTaskFile): string {
  if (task.foremanTask !== 1) throw new Error("the task file must be version 1");
  if (typeof task.instructions !== "string" || task.instructions.trim() === "") {
    throw new Error("the task needs its instructions");
  }
  if (typeof task.input !== "string" || task.input.trim() === "") {
    throw new Error("the task needs its input");
  }
  const usesClaudeCode = role === "developer" || role === "designer";
  if (usesClaudeCode) {
    const tools = task.allowedTools ?? [];
    if (tools.length === 0 || !tools.every((t) => TOOL.test(t))) {
      throw new Error(`a ${role} task needs its allowed tools`);
    }
    if (!UUID.test(task.nodeId ?? ""))
      throw new Error(`a ${role} task needs its node id`);
    if (!BRANCH.test(task.branch ?? "") || (task.branch ?? "").endsWith(".lock")) {
      throw new Error(`a ${role} task needs its branch`);
    }
  } else {
    if (task.allowedTools !== undefined) {
      throw new Error(`a ${role} run has no Claude Code tools`);
    }
    if (task.branch !== undefined) throw new Error(`a ${role} task has no branch`);
  }
  if (role === "qa") {
    if (!UUID.test(task.nodeId ?? "")) throw new Error("a QA task needs its node id");
    const ids = task.evidenceIds ?? [];
    if (ids.length > 50 || !ids.every((id) => UUID.test(id))) {
      throw new Error("a QA task's evidence ids must be at most 50 UUIDs");
    }
  } else if (task.evidenceIds !== undefined) {
    throw new Error("only a QA task carries evidence ids");
  }
  const visual = task.images !== undefined;
  if (visual) {
    const images = task.images ?? [];
    if (!IMAGE_ROLES.includes(role))
      throw new Error("only a QA or Council task carries images");
    if (
      !Array.isArray(images) ||
      images.length === 0 ||
      images.length > MAX_TASK_IMAGES
    ) {
      throw new Error(`a ${role} task's images must be 1 to ${MAX_TASK_IMAGES}`);
    }
    for (const image of images) {
      if (
        !isObject(image) ||
        Object.keys(image).length !== 3 ||
        typeof image.label !== "string" ||
        !LABEL.test(image.label) ||
        image.mediaType !== "image/png" ||
        typeof image.data !== "string" ||
        !BASE64.test(image.data)
      ) {
        throw new Error(
          `each of a ${role} task's images needs a label, image/png and base64 data`,
        );
      }
    }
    if ((task.evidenceIds ?? []).length > 0) {
      throw new Error("a QA task with images cites no evidence ids");
    }
  }
  const structured = role === "council" || role === "triage" || visual;
  if (structured && !isObject(task.outputSchema)) {
    throw new Error(`a ${role} task needs its output schema`);
  }
  if (!structured && task.outputSchema !== undefined) {
    throw new Error(`a ${role} task has no output schema`);
  }
  const json = JSON.stringify(task);
  if (Buffer.byteLength(json, "utf8") > MAX_TASK_BYTES) {
    throw new Error("the task file is too large");
  }
  return json;
}
