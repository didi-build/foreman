// Seam: unit. The task types check and the role default (ADR 0114 section 1). The real file in
// contracts/task-types.yaml is checked in test/contracts-task-types.test.ts.
import { describe, expect, it } from "vitest";

import { TEST_TASK_TYPES } from "./routing-testing.ts";
import { taskTypeFor, validateTaskTypes } from "./task-types.ts";

const roles = {
  developer: {
    allowed: ["developer:code", "developer:infra"],
    default: "developer:code",
  },
  designer: { allowed: ["designer"], default: "designer" },
  qa: { allowed: ["qa:review"], default: "qa:review" },
  council: { allowed: ["council"], default: "council" },
  triage: { allowed: ["triage"], default: "triage" },
};

const file = (extra: Record<string, unknown> = {}) => ({
  task_types: TEST_TASK_TYPES.meanings,
  roles,
  ...extra,
});

describe("task types (unit, ADR 0114 section 1)", () => {
  it("accepts the six task types with each role's allowed list and default", () => {
    expect(validateTaskTypes("e".repeat(40), file())).toEqual({
      taskTypes: TEST_TASK_TYPES,
      problems: [],
    });
  });

  it("gives each role its default, so every Developer run is developer:code until M3.6", () => {
    expect(taskTypeFor(TEST_TASK_TYPES, "developer")).toBe("developer:code");
    expect(taskTypeFor(TEST_TASK_TYPES, "qa")).toBe("qa:review");
    expect(taskTypeFor(TEST_TASK_TYPES, "triage")).toBe("triage");
  });

  it("collects every problem, naming the field", () => {
    const { taskTypes, problems } = validateTaskTypes(
      "v",
      file({
        extra: 1,
        task_types: { ...TEST_TASK_TYPES.meanings, "Bad Id": "x", council: "" },
        roles: {
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
      }),
    );
    expect(taskTypes).toBeUndefined();
    expect(problems).toEqual(
      expect.arrayContaining([
        "task types: unknown field extra",
        "task_types: an id must be a role, optionally with :class",
        "task_types.council needs a meaning",
        "roles: unknown role scanner",
        "roles.developer.allowed names a task type of another role",
        "roles.designer.allowed names a task type that task_types does not list",
        "roles.qa.default must be one of its allowed task types",
        "roles.triage needs allowed and default",
      ]),
    );
  });

  it("refuses a file that is not a mapping, and an empty version", () => {
    expect(validateTaskTypes("v", ["developer"]).problems).toEqual([
      "task types must be a mapping",
    ]);
    expect(validateTaskTypes("", file()).problems).toEqual([
      "version must be a non-empty string",
    ]);
  });
});
