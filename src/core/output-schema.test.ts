// Seam: unit. The output schema subset (src/core/output-schema.ts, D-228): which schemas are
// accepted, and how an answer is checked against one. Problems name the field, never a value.
import { describe, expect, it } from "vitest";

import { outputProblem, outputSchemaProblems } from "./output-schema.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "items", "done"],
  properties: {
    kind: { type: "string", enum: ["a", "b"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" }, count: { type: "integer" } },
      },
    },
    done: { type: "boolean" },
    score: { type: "number", description: "Optional." },
  },
};

describe("output schemas (unit, D-228)", () => {
  it("accepts the supported subset", () => {
    expect(outputSchemaProblems(SCHEMA, "s")).toEqual([]);
  });

  it("refuses every keyword it cannot check, and a loose or broken object", () => {
    expect(
      outputSchemaProblems(
        {
          type: "object",
          properties: {
            a: { type: "string", pattern: "^x" },
            b: { type: "array" },
            c: { type: "string", enum: [] },
            d: { type: "null" },
          },
          required: ["a", "a", "z"],
        },
        "s",
      ),
    ).toEqual([
      "s.additionalProperties must be false",
      "s.properties.a: keyword pattern is not supported on type string",
      "s.properties.b.items must be a mapping",
      "s.properties.c.enum must be a non-empty list of text",
      "s.properties.d.type must be object, array, string, boolean, number or integer",
      "s.required must list distinct fields of its properties",
    ]);
    expect(outputSchemaProblems([], "s")).toEqual(["s must be a mapping"]);
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 8; i++) deep = { type: "array", items: deep };
    expect(outputSchemaProblems(deep, "s").join()).toContain("is nested too deeply");
  });

  it("checks an answer, naming the first field that does not fit and never its value", () => {
    const good = { kind: "a", items: [{ id: "x", count: 2 }], done: true };
    expect(outputProblem(SCHEMA, good)).toBeNull();
    expect(outputProblem(SCHEMA, { ...good, score: 0.5 })).toBeNull();
    const secret = "sk-not-a-real-key";
    for (const [answer, problem] of [
      [null, "the answer is not an object"],
      [{ ...good, extra: secret }, "the answer has a field the schema does not allow"],
      [{ kind: "a", items: [] }, "the answer done is missing"],
      [{ ...good, kind: secret }, "kind must be one of the schema's values"],
      [{ ...good, items: {} }, "items must be a list"],
      [{ ...good, items: [{ id: 1 }] }, "items[0].id must be text"],
      [
        { ...good, items: [{ id: "x", count: 1.5 }] },
        "items[0].count must be a whole number",
      ],
      [{ ...good, items: [{}] }, "items[0] id is missing"],
      [{ ...good, done: "yes" }, "done must be true or false"],
      [{ ...good, score: "high" }, "score must be a number"],
    ] as const) {
      const found = outputProblem(SCHEMA, answer);
      expect(found).toBe(problem);
      expect(found).not.toContain(secret);
    }
  });
});
