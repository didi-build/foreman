// Seam: unit. The persona check (ADR 0119, D-455, D-456) and the composition of a run's
// instructions (ADR 0119 slice 2) over synthetic files. The real files in contracts/personas/ are
// checked in test/contracts-personas.test.ts, and composed with the real bot files in
// src/adapters/contracts-file/bot-files.test.ts.
import { describe, expect, it } from "vitest";

import {
  COMPOSED_HEADINGS,
  PERSONA_NAMES,
  PERSONAS,
  composeInstructions,
  validatePersonas,
  type Personas,
  type RawPersonaFiles,
} from "./personas.ts";

const shared = () => ({
  user_flow: ["Care about the flow."],
  intent: ["Work toward the plan."],
  uncertainty: ["Say what you are unsure of."],
  communication: ["Write plainly."],
  security_and_privacy: ["Never write a secret."],
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
    expect(personas?.shared.securityAndPrivacy).toEqual(["Never write a secret."]);
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

/** The synthetic files, checked, with the Designer's notes and the Developer's own standards. */
const checked = (): Personas => {
  const { personas } = validatePersonas(
    files((raw) => {
      raw.personas.designer = persona("designer", {
        notes: ["A note.", "Another note."],
      });
      raw.personas.developer = persona("developer", {
        craft_standards: ["Name each constant.", "Keep the change small."],
      });
    }),
  );
  if (!personas) throw new Error("the synthetic persona files do not pass the check");
  return personas;
};

const TASK = "Review the change.\n\nThen answer.\n";

describe("composed instructions (unit, ADR 0119 slice 2)", () => {
  it("gives the shared base, the persona and the task, in order, with each label, as one text", () => {
    expect(
      composeInstructions({ personas: checked(), persona: "quality", task: TASK }),
    ).toBe(
      [
        "## What every agent shares",
        "",
        "The user's flow:",
        "- Care about the flow.",
        "",
        "Didi's intent:",
        "- Work toward the plan.",
        "",
        "Uncertainty:",
        "- Say what you are unsure of.",
        "",
        "How you communicate:",
        "- Write plainly.",
        "",
        "Security and privacy:",
        "- Never write a secret.",
        "",
        "## Your persona",
        "",
        "You are quality.",
        "",
        "What you care about most, most important first:",
        "- First.",
        "- Second.",
        "",
        "How you do good work:",
        "- A standard.",
        "",
        "What you watch for:",
        "- A risk.",
        "",
        "What you never do:",
        "- A line not to cross.",
        "",
        "What you need to know:",
        "- A source.",
        "",
        "## Your task",
        "",
        "Review the change.",
        "",
        "Then answer.",
      ].join("\n"),
    );
  });

  it("adds the notes only when the persona has them, after what it needs to know", () => {
    const personas = checked();
    const designer = composeInstructions({ personas, persona: "designer", task: TASK });
    expect(designer).toContain(
      "What you need to know:\n- A source.\n\nNotes:\n- A note.\n- Another note.\n\n## Your task",
    );
    for (const id of ["product", "developer", "quality"] as const) {
      expect(composeInstructions({ personas, persona: id, task: TASK })).not.toContain(
        "Notes:",
      );
    }
  });

  it("adds another persona's craft standards only when the task asks, named at the start of the sentence", () => {
    const personas = checked();
    const designer = composeInstructions({
      personas,
      persona: "designer",
      withCraftStandardsOf: "developer",
      task: TASK,
    });
    expect(designer).toContain(
      "- Another note.\n\nThe Developer's craft standards, which you also hold the work to:\n- Name each constant.\n- Keep the change small.\n\n## Your task",
    );
    expect(
      composeInstructions({
        personas,
        persona: "designer",
        withCraftStandardsOf: "quality",
        task: TASK,
      }),
    ).toContain(
      "Quality's craft standards, which you also hold the work to:\n- A standard.",
    );
    expect(
      composeInstructions({ personas, persona: "designer", task: TASK }),
    ).not.toContain("which you also hold the work to");
    expect(PERSONA_NAMES).toEqual({
      product: "Product",
      developer: "the Developer",
      designer: "the Designer",
      quality: "Quality",
    });
  });

  it("puts the task's text last and unchanged but for its trailing whitespace, with none at any line's end", () => {
    const task = "  Step one.\n\n```text\nkeep this\n```\n\n";
    const text = composeInstructions({
      personas: checked(),
      persona: "product",
      withCraftStandardsOf: "developer",
      task,
    });
    expect(text.endsWith(`${COMPOSED_HEADINGS.task}\n\n${task.trimEnd()}`)).toBe(true);
    expect(text.indexOf(COMPOSED_HEADINGS.task)).toBe(
      text.lastIndexOf(COMPOSED_HEADINGS.task),
    );
    expect(text.indexOf(COMPOSED_HEADINGS.shared)).toBe(0);
    expect(text.indexOf(COMPOSED_HEADINGS.persona)).toBeGreaterThan(0);
    expect(text.indexOf(COMPOSED_HEADINGS.task)).toBeGreaterThan(
      text.indexOf(COMPOSED_HEADINGS.persona),
    );
    expect(text).not.toMatch(/[ \t]$/m);
    expect(text).not.toMatch(/\n\n\n/);
    expect(text).not.toMatch(/\s$/);
  });
});
