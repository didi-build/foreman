// Task types (ADR 0114 section 1): the role plus a small task class, the unit model routing and
// the scorecard use. The list is data in contracts/task-types.yaml at the spec version (ADR 0105).
// The contracts-file adapter parses it; this module only checks the plain object and picks a
// run's task type.
import type { AgentRole } from "./store.ts";

export interface RoleTaskTypes {
  allowed: string[];
  default: string;
}

export interface TaskTypes {
  /** The spec version the file was loaded at. */
  version: string;
  /** Each task type id and what it means. */
  meanings: Record<string, string>;
  roles: Record<AgentRole, RoleTaskTypes>;
}

export interface TaskTypesResult {
  /** Present only when there are no problems. */
  taskTypes?: TaskTypes;
  problems: string[];
}

const ROLES: readonly AgentRole[] = [
  "developer",
  "qa",
  "designer",
  "council",
  "triage",
];

/** A role name, optionally followed by a colon and a task class, for example `developer:code`. */
export const TASK_TYPE_ID = /^[a-z]+(:[a-z]+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const unknownKeys = (value: Record<string, unknown>, allowed: string[]): string[] =>
  Object.keys(value).filter((key) => !allowed.includes(key));

/**
 * Checks the parsed task-types file, collecting every problem at once: an unknown field, a bad
 * id, a role with no entry, an allowed type that is not listed, a default outside the allowed list.
 * Problems name the field, never a value from the file.
 */
export function validateTaskTypes(version: string, raw: unknown): TaskTypesResult {
  const problems: string[] = [];
  if (!isText(version)) problems.push("version must be a non-empty string");
  if (!isRecord(raw)) return { problems: ["task types must be a mapping"] };
  for (const key of unknownKeys(raw, ["task_types", "roles"])) {
    problems.push(`task types: unknown field ${key}`);
  }

  const meanings: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (!isRecord(raw.task_types)) {
    problems.push("task_types must be a mapping of task type ids");
  } else {
    for (const [id, meaning] of Object.entries(raw.task_types)) {
      if (!TASK_TYPE_ID.test(id)) {
        problems.push("task_types: an id must be a role, optionally with :class");
        continue;
      }
      if (!isText(meaning)) problems.push(`task_types.${id} needs a meaning`);
      else meanings[id] = meaning;
    }
  }

  const roles = {} as Record<AgentRole, RoleTaskTypes>;
  if (!isRecord(raw.roles)) {
    problems.push("roles must be a mapping of agent roles");
  } else {
    for (const key of unknownKeys(raw.roles, [...ROLES])) {
      problems.push(`roles: unknown role ${key}`);
    }
    for (const role of ROLES) {
      const entry = raw.roles[role];
      const where = `roles.${role}`;
      if (!isRecord(entry)) {
        problems.push(`${where} needs allowed and default`);
        continue;
      }
      for (const key of unknownKeys(entry, ["allowed", "default"])) {
        problems.push(`${where}: unknown field ${key}`);
      }
      const allowed = entry.allowed;
      if (
        !Array.isArray(allowed) ||
        allowed.length === 0 ||
        !allowed.every((id): id is string => typeof id === "string")
      ) {
        problems.push(`${where}.allowed must be a non-empty list of task type ids`);
        continue;
      }
      if (allowed.some((id) => !Object.hasOwn(meanings, id))) {
        problems.push(
          `${where}.allowed names a task type that task_types does not list`,
        );
      }
      if (allowed.some((id) => id !== role && !id.startsWith(`${role}:`))) {
        problems.push(`${where}.allowed names a task type of another role`);
      }
      if (typeof entry.default !== "string" || !allowed.includes(entry.default)) {
        problems.push(`${where}.default must be one of its allowed task types`);
        continue;
      }
      roles[role] = { allowed: [...allowed], default: entry.default };
    }
  }

  if (problems.length > 0) return { problems };
  return { taskTypes: { version, meanings, roles }, problems };
}

/**
 * The task type a run of `role` gets: the role's default (ADR 0114 section 1). An item's own task
 * class is read here once M3.6 settles who sets it; until then every Developer run is
 * `developer:code`.
 */
export function taskTypeFor(taskTypes: TaskTypes, role: AgentRole): string {
  return taskTypes.roles[role].default;
}
