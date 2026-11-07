// Fakes of the register-project form's two ports (src/core/register-project.ts, O-109), for the
// core and flow tests. Synthetic data only; nothing reaches GitHub.
import {
  PROJECT_TEMPLATE,
  projectRepository,
  type ProjectRepositories,
  type ProjectSettings,
  type RepositoryFacts,
  type TemplateGenerate,
} from "../../core/register-project.ts";

export interface FakeProjectSettings extends ProjectSettings {
  /** The slugs the settings file lists; `"fail"` makes the read throw. */
  listed: string[] | "fail";
  reads: number;
}

export function createFakeProjectSettings(listed: string[] = []): FakeProjectSettings {
  const fake: FakeProjectSettings = {
    listed,
    reads: 0,
    async listedSlugs() {
      fake.reads += 1;
      if (fake.listed === "fail") throw new Error("the fake settings read failed");
      return [...fake.listed];
    },
  };
  return fake;
}

/** A public repository generated from Launchpad under exactly this slug's name. */
export const launchpadRepository = (slug: string): RepositoryFacts => ({
  fullName: projectRepository(slug),
  private: false,
  visibility: "public",
  templateFullName: PROJECT_TEMPLATE,
});

export interface FakeProjectRepositories extends ProjectRepositories {
  /** Repositories that exist, by slug. A generate of one of them answers not created. */
  existing: Map<string, RepositoryFacts>;
  /** What the next generate answers instead of creating, once; `"throw"` makes it throw. */
  nextGenerate: TemplateGenerate | "throw" | null;
  /** Makes every read throw. */
  failReads: boolean;
  generated: { name: string; description: string }[];
  reads: string[];
}

export function createFakeProjectRepositories(): FakeProjectRepositories {
  const fake: FakeProjectRepositories = {
    existing: new Map(),
    nextGenerate: null,
    failReads: false,
    generated: [],
    reads: [],
    async generate(request) {
      fake.generated.push({ ...request });
      const next = fake.nextGenerate;
      fake.nextGenerate = null;
      if (next === "throw") throw new Error("the fake create failed");
      if (next) return next;
      if (fake.existing.has(request.name)) return { kind: "not_created" };
      const made = launchpadRepository(request.name);
      fake.existing.set(request.name, made);
      return { kind: "created", repository: { ...made } };
    },
    async read(name) {
      fake.reads.push(name);
      if (fake.failReads) throw new Error("the fake read failed");
      const found = fake.existing.get(name);
      return found ? { ...found } : null;
    },
  };
  return fake;
}
