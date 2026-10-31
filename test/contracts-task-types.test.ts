// Seam: unit, repo guard (ADR 0114 section 1, ADR 0105). contracts/task-types.yaml loads through
// the contracts-file adapter and passes the core's check, and the core tests' copy of it
// (TEST_TASK_TYPES) matches the file.
import { describe, expect, it } from "vitest";

import { loadTaskTypesFile } from "../src/adapters/contracts-file/load.ts";
import { TEST_TASK_TYPES } from "../src/core/routing-testing.ts";
import { validateTaskTypes } from "../src/core/task-types.ts";

describe("contracts/task-types.yaml (unit: repo guard, ADR 0114 section 1)", () => {
  it("is valid and equals the copy the core tests use", () => {
    const { taskTypes, problems } = validateTaskTypes(
      TEST_TASK_TYPES.version,
      loadTaskTypesFile(),
    );
    expect(problems).toEqual([]);
    expect(taskTypes).toEqual(TEST_TASK_TYPES);
  });

  it("names the six task types of ADR 0114 section 1", () => {
    expect(Object.keys(TEST_TASK_TYPES.meanings).sort()).toEqual([
      "council",
      "designer",
      "developer:code",
      "developer:infra",
      "qa:review",
      "triage",
    ]);
  });
});
