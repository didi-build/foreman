// Seam: unit. The task types check and the role default (ADR 0114 section 1). The real files,
// contracts/task-types.yaml and each bot file's task_types, are checked in
// test/contracts-task-types.test.ts.
import { describe, expect, it } from "vitest";

import { TEST_TASK_TYPES } from "./routing-testing.ts";
import { taskTypeFor, validateTaskTypes } from "./task-types.ts";

const roles = {
  developer: {
    allowed: ["developer:code", "developer:infra"],
    default: "developer:code",
  },
  designer: { allowed: ["designer"], default: "designer" },
  qa: { allowed: ["qa:review", "qa:visual"], default: "qa:review" },
  council: { allowed: ["council", "council:visual"], default: "council" },
  triage: { allowed: ["triage"], default: "triage" },
};

const file = (extra: Record<string, unknown> = {}) => ({
  task_types: TEST_TASK_TYPES.meanings,
  ...extra,
});

describe("task types (unit, ADR 0114 section 1)", () => {
  it("accepts the eight task types with each role's allowed list and default", () => {
    expect(validateTaskTypes("e".repeat(40), file(), roles)).toEqual({
      taskTypes: TEST_TASK_TYPES,
      problems: [],
    });
  });

  it("gives each role its default, so every Developer run is developer:code until M3.6", () => {
    expect(taskTypeFor(TEST_TASK_TYPES, "developer")).toBe("developer:code");
    expect(taskTypeFor(TEST_TASK_TYPES, "qa")).toBe("qa:review");
    expect(taskTypeFor(TEST_TASK_TYPES, "triage")).toBe("triage");
  });

  it("gives a requested task type only when the role's bot file allows it (D-242)", () => {
    expect(taskTypeFor(TEST_TASK_TYPES, "qa", "qa:visual")).toBe("qa:visual");
    expect(taskTypeFor(TEST_TASK_TYPES, "qa", null)).toBe("qa:review");
    expect(() => taskTypeFor(TEST_TASK_TYPES, "developer", "qa:visual")).toThrow(
      "does not allow the requested task type",
    );
  });

  it("collects every problem, naming the field", () => {
    const { taskTypes, problems } = validateTaskTypes(
      "v",
      file({
        extra: 1,
        roles,
        task_types: { ...TEST_TASK_TYPES.meanings, "Bad Id": "x", council: "" },
      }),
      {
        ...roles,
        developer: {
          allowed: ["developer:code", "qa:review"],
          default: "developer:code",
        },
        designer: { allowed: ["designer:art"], default: "designer:art" },
        qa: { allowed: ["qa:review"], default: "triage" },
        triage: undefined,
        scanner: roles.council,
      },
    );
    expect(taskTypes).toBeUndefined();
    expect(problems).toEqual(
      expect.arrayContaining([
        "task types: unknown field extra",
        // The roles live in the bot files now; the task types file may not carry them.
        "task types: unknown field roles",
        "task_types: an id must be a role, optionally with :class",
        "task_types.council needs a meaning",
        "task types: unknown role scanner",
        "the developer bot file's task_types.allowed names a task type of another role",
        "the designer bot file's task_types.allowed names a task type that task_types does not list",
        "the qa bot file's task_types.default must be one of its allowed task types",
        "the triage bot file's task_types needs allowed and default",
      ]),
    );
  });

  it("refuses a file that is not a mapping, and an empty version", () => {
    expect(validateTaskTypes("v", ["developer"], roles).problems).toEqual([
      "task types must be a mapping",
    ]);
    expect(validateTaskTypes("", file(), roles).problems).toEqual([
      "version must be a non-empty string",
    ]);
  });
});
