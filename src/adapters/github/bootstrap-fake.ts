// A fake of `BOOTSTRAP_TOKEN`'s access and of Bootstrap's runs (src/core/bootstrap-access.ts,
// O-114), one object for both ports so a grant, a restart and a removal see the same state. For
// the core, flow and receiver tests. Synthetic data only; nothing reaches GitHub.
import {
  RESTART_EVENT,
  type BootstrapAccess,
  type BootstrapRun,
  type BootstrapRuns,
  type GitHubChange,
} from "../../core/bootstrap-access.ts";

type Step = Extract<GitHubChange, { kind: "refused" }>["step"];

export interface FakeBootstrap extends BootstrapAccess, BootstrapRuns {
  /** The names on the secret's list of selected repositories. */
  selected: Set<string>;
  /** Each call in order, as `"<method> <name>"`, or `"list"`. */
  calls: string[];
  /** Runs by repository name, oldest first. */
  runs: Map<string, BootstrapRun[]>;
  /** A step each call of that method refuses at, until cleared. */
  refuse: { grant?: Step; remove?: Step; restart?: Step };
  /** GitHub's status a refused restart call names, when set. */
  restartStatus?: number;
  /** Makes `list` throw. */
  failList: boolean;
  /** Makes `latestRestart` throw. */
  failRunReads: boolean;
  /** Ends the newest restarted run on the repository with this conclusion. */
  finish(name: string, conclusion: string): void;
}

export function createFakeBootstrap(): FakeBootstrap {
  const change = (
    method: "grant" | "remove",
    name: string,
    apply: () => void,
  ): GitHubChange => {
    fake.calls.push(`${method} ${name}`);
    const step = fake.refuse[method];
    if (step) return { kind: "refused", step };
    apply();
    return { kind: "done" };
  };
  const restarted = (name: string) =>
    (fake.runs.get(name) ?? []).filter((r) => r.event === RESTART_EVENT);
  const fake: FakeBootstrap = {
    selected: new Set(),
    calls: [],
    runs: new Map(),
    refuse: {},
    failList: false,
    failRunReads: false,
    async grant(name) {
      return change("grant", name, () => fake.selected.add(name));
    },
    async remove(name) {
      return change("remove", name, () => fake.selected.delete(name));
    },
    async list() {
      fake.calls.push("list");
      if (fake.failList) throw new Error("the fake list failed");
      return [...fake.selected];
    },
    async restart(name) {
      fake.calls.push(`restart ${name}`);
      const step = fake.refuse.restart;
      if (step) {
        const status = fake.restartStatus;
        return { kind: "refused", step, ...(status === undefined ? {} : { status }) };
      }
      fake.runs.set(name, [
        ...(fake.runs.get(name) ?? []),
        { event: RESTART_EVENT, status: "queued", conclusion: null },
      ]);
      return { kind: "done" };
    },
    async latestRestart(name) {
      fake.calls.push(`latestRestart ${name}`);
      if (fake.failRunReads) throw new Error("the fake run read failed");
      const run = restarted(name).at(-1);
      return run ? { ...run } : null;
    },
    finish(name, conclusion) {
      const run = restarted(name).at(-1);
      if (!run) throw new Error(`no restarted run on ${name}`);
      run.status = "completed";
      run.conclusion = conclusion;
    },
  };
  return fake;
}
