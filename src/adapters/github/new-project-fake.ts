// Fakes of the New project form's GitHub ports (src/core/new-project.ts, O-161): the settings
// (Foreman's standard size, the project files and their create-only write), the two workflow
// starts and the project repositories (src/core/project-repository.ts, O-109), for the core and
// flow tests. Synthetic data only; nothing reaches GitHub.
import type {
  ProjectFile,
  ProjectFileCreate,
  ProjectSettings,
  ProjectWorkflows,
  WorkflowStart,
} from "../../core/new-project.ts";
import type { ProjectQuota } from "../../core/project-entry.ts";
import {
  PROJECT_TEMPLATE,
  projectRepository,
  type ProjectRepositories,
  type RepositoryFacts,
  type TemplateGenerate,
} from "../../core/project-repository.ts";

/** The rehearsal's quota, the standard size (D-436). */
export const STANDARD_QUOTA: ProjectQuota = {
  pods: 12,
  cpu: "6",
  memory: "5Gi",
  ephemeralStorage: "11Gi",
  storage: "3Gi",
  persistentVolumeClaims: 3,
};

export interface FakeProjectSettings extends ProjectSettings {
  /** Foreman's standard size on main; `"fail"` makes the read throw. */
  quota: ProjectQuota | "fail";
  /** The files on the settings repository's main, by slug. */
  files: Map<string, ProjectFile>;
  /** Makes every file read throw. */
  failReads: boolean;
  /** What the next create answers instead of writing, once; `"throw"` makes it throw. */
  nextCreate: ProjectFileCreate | "throw" | null;
  /** Each create asked for, in order. */
  creates: { slug: string; text: string; message: string }[];
  /** Each read, in order: `quota`, or the slug of a file read. */
  reads: string[];
}

export function createFakeProjectSettings(): FakeProjectSettings {
  let commits = 0;
  const fake: FakeProjectSettings = {
    quota: { ...STANDARD_QUOTA },
    files: new Map(),
    failReads: false,
    nextCreate: null,
    creates: [],
    reads: [],
    async standardQuota() {
      fake.reads.push("quota");
      if (fake.quota === "fail") throw new Error("the fake settings read failed");
      return { ...fake.quota };
    },
    async readFile(slug) {
      fake.reads.push(slug);
      if (fake.failReads) throw new Error("the fake file read failed");
      const file = fake.files.get(slug);
      return file ? { ...file } : null;
    },
    async createFile(request) {
      fake.creates.push({ ...request });
      const next = fake.nextCreate;
      fake.nextCreate = null;
      if (next === "throw") throw new Error("the fake write failed");
      if (next) return next;
      // As GitHub without a `sha`: an existing file is never replaced.
      if (fake.files.has(request.slug)) return { kind: "not_created" };
      commits += 1;
      const commit = String(commits).padStart(40, "c");
      fake.files.set(request.slug, { text: request.text, commit });
      return { kind: "created", commit };
    },
  };
  return fake;
}

export interface FakeProjectWorkflows extends ProjectWorkflows {
  /** Each start asked for, by its `projects_commit`. */
  starts: string[];
  /** What the next start answers for each workflow, once; started with a run link otherwise. */
  next: { platform?: WorkflowStart; infra?: WorkflowStart } | "throw" | null;
}

export function createFakeProjectWorkflows(): FakeProjectWorkflows {
  let runs = 0;
  const started = (): WorkflowStart => {
    runs += 1;
    return {
      kind: "started",
      link: `https://github.com/didi-build/foreman/actions/runs/${9000 + runs}`,
    };
  };
  const fake: FakeProjectWorkflows = {
    starts: [],
    next: null,
    async start(projectsCommit) {
      fake.starts.push(projectsCommit);
      const next = fake.next;
      fake.next = null;
      if (next === "throw") throw new Error("the fake start failed");
      return {
        platform: next?.platform ?? started(),
        infra: next?.infra ?? started(),
      };
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
