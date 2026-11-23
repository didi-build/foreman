// Seam: unit. The persona check (ADR 0119, D-455, D-456) over synthetic files. The real files in
// contracts/personas/ are checked in test/contracts-personas.test.ts.
import { describe, expect, it } from "vitest";

import { PERSONAS, validatePersonas, type RawPersonaFiles } from "./personas.ts";

const shared = () => ({
  user_flow: ["Care about the flow."],
  intent: ["Work toward the plan."],
  uncertainty: ["Say what you are unsure of."],
  communication: ["Write plainly."],
  secrets_and_personal_data: ["Never write a secret."],
});

const persona = (id: string, extra: Record<string, unknown> = {}) => ({
  persona: id,
  lens: `You are ${id}.`,
  cares_most_about: ["First.", "Second."],
  craft_standards: ["A standard."],
  watches_for: ["A risk."],
  never: ["A line not to cross."],
  needs_to_know: ["A source."],
  ...extra,
});

const files = (
  change: (raw: {
    shared: unknown;
    personas: Record<string, unknown>;
  }) => void = () => {},
): RawPersonaFiles => {
  const raw = {
    shared: shared() as unknown,
    personas: Object.fromEntries(PERSONAS.map((id) => [id, persona(id)])),
  };
  change(raw);
  return raw;
};

describe("persona files (unit, ADR 0119)", () => {
  it("accepts the shared base and the four personas, with notes optional, in the files' order", () => {
    const { personas, problems } = validatePersonas(
      files((raw) => {
        raw.personas.designer = persona("designer", { notes: ["  A note.  "] });
      }),
    );
    expect(problems).toEqual([]);
    expect(Object.keys(personas?.personas ?? {})).toEqual([
      "product",
      "developer",
      "designer",
      "quality",
    ]);
    expect(personas?.personas.product).toEqual({
      id: "product",
      lens: "You are product.",
      caresMostAbout: ["First.", "Second."],
      craftStandards: ["A standard."],
      watchesFor: ["A risk."],
      never: ["A line not to cross."],
      needsToKnow: ["A source."],
      notes: [],
    });
    expect(personas?.personas.designer.notes).toEqual(["A note."]);
    expect(personas?.shared.secretsAndPersonalData).toEqual(["Never write a secret."]);
  });

  it("collects every problem in the personas, naming the file and the part, never a value", () => {
    const { personas, problems } = validatePersonas(
      files((raw) => {
        raw.personas.product = persona("developer", { model: "secret-model-name" });
        raw.personas.developer = persona("developer", {
          lens: "Two\nlines.",
          craft_standards: [],
        });
        raw.personas.designer = persona("designer", {
          watches_for: ["Fine.", 7],
          notes: [],
        });
        const quality = persona("quality") as Record<string, unknown>;
        delete quality.never;
        raw.personas.quality = quality;
        raw.personas.security = persona("security");
      }),
    );
    expect(personas).toBeUndefined();
    expect(problems).toEqual([
      "security.yaml is not the file of a persona",
      "product.yaml: unknown part model",
      "product.yaml: persona must be product, its file's name",
      "developer.yaml craft_standards must be a non-empty list of text",
      "developer.yaml lens must be non-empty text on one line",
      "designer.yaml watches_for: each entry must be non-empty text on one line",
      "designer.yaml notes must be a non-empty list of text",
      "quality.yaml never must be a non-empty list of text",
    ]);
    expect(problems.join(" ")).not.toContain("secret-model-name");
  });

  it("refuses a missing file, a file that is not a mapping, and an entry that is not one line", () => {
    const { problems } = validatePersonas(
      files((raw) => {
        delete raw.personas.quality;
        raw.personas.designer = ["not", "a", "mapping"];
        raw.personas.product = persona("product", { lens: "   " });
        raw.personas.developer = persona("developer", { never: ["One.\nTwo."] });
      }),
    );
    expect(problems).toEqual([
      "product.yaml lens must be non-empty text on one line",
      "developer.yaml never: each entry must be non-empty text on one line",
      "designer.yaml must be a mapping of its parts",
      "quality.yaml is missing",
    ]);
  });

  it("checks the shared base: exactly its five parts, each a non-empty list of text", () => {
    expect(
      validatePersonas(
        files((raw) => {
          const base = shared() as Record<string, unknown>;
          delete base.intent;
          base.uncertainty = "Not a list.";
          base.tone = ["Unknown part."];
          raw.shared = base;
        }),
      ).problems,
    ).toEqual([
      "shared.yaml: unknown part tone",
      "shared.yaml intent must be a non-empty list of text",
      "shared.yaml uncertainty must be a non-empty list of text",
    ]);
    expect(
      validatePersonas(
        files((raw) => {
          raw.shared = undefined;
        }),
      ).problems,
    ).toEqual(["shared.yaml is missing"]);
    expect(
      validatePersonas(
        files((raw) => {
          raw.shared = "text";
        }),
      ).problems,
    ).toEqual(["shared.yaml must be a mapping of its parts"]);
  });
});
