// Access to the organization secret `BOOTSTRAP_TOKEN` only during a repository's own setup
// (D-358 lock (2), O-114). The secret is shared with selected repositories only, normally none.
// Only its name is used here, in GitHub's paths: GitHub's API never returns a secret's value, and
// nothing here reads, moves or logs one.
//
// Three steps change the secret's list of selected repositories, each through the ports below:
// 1. Didi's register-project form (./register-project.ts), once the repository exists and the
//    project is recorded: `startSetup` adds the repository to the list, then starts Bootstrap
//    again on main (its first run, at creation, had no token).
// 2. When Bootstrap's restarted run ends, whatever its conclusion, `removeAfterBootstrap` removes
//    the repository. The GitHub receiver starts it on `workflow_run` `completed` for
//    `.github/workflows/bootstrap.yml` (flows/remove-bootstrap-access.ts).
// 3. The reconcile pass's backstop, `bootstrapAccessPass`, lists the secret's repositories and
//    removes each one outside its setup window: a registered project, registered less than
//    `SETUP_WINDOW_MINUTES` ago, whose setup has not finished. Any other repository, `foreman`
//    and `launchpad` included, is removed.
//
// What "finished" means (O-114): a project's setup has finished once the newest run of Bootstrap
// on its repository that was started by `workflow_dispatch` (the form's restart, made once access
// is granted) has completed. It succeeded when that run's conclusion is `success`, and failed with
// any other conclusion. Before such a run exists, and while it is queued or running, setup has not
// finished. GitHub keeps the runs, so nothing is recorded in the store for this: the form, the
// backstop and the daily check read the same newest run (`setupStateOf`) with the runner App's
// `actions: read` token (D-267). Bootstrap fails, rather than skips, a run that needs the token in
// `didi-build` and has none (`resolveTokenPolicy`, scripts/lib/bootstrap.mjs), so a successful
// restarted run is one that had the token.
//
// The switches: under the kill switch none of the three acts (the existing rule; whether a step
// that only narrows access should still run is N-100). Dry run reports what each would do and
// changes nothing on GitHub. Every refusal is fixed text that quotes no token and no input.
import type { Clock } from "./library.ts";
import type { Project, StoreOps } from "./store.ts";

/** The GitHub organization that owns the secret and every project repository (D-345). */
export const GITHUB_ORGANIZATION = "didi-build";

/** The organization secret's name, used only in GitHub's paths. Never its value. */
export const BOOTSTRAP_SECRET = "BOOTSTRAP_TOKEN";

/** Launchpad's Bootstrap workflow, by its file name (GitHub's `workflow_id`) and its path. */
export const BOOTSTRAP_WORKFLOW_FILE = "bootstrap.yml";
export const BOOTSTRAP_WORKFLOW_PATH = ".github/workflows/bootstrap.yml";

/** The branch the form starts Bootstrap on. */
export const BOOTSTRAP_REF = "main";

/** The event of the form's restart, the run whose end removes the access. */
export const RESTART_EVENT = "workflow_dispatch";

/** How long after registration a repository may keep access while its setup runs (D-358). */
export const SETUP_WINDOW_MINUTES = 60;

/**
 * A repository name in the organization as GitHub allows it. `.` and `..` are refused apart,
 * since GitHub reserves them.
 */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export const isRepositoryName = (name: unknown): name is string =>
  typeof name === "string" &&
  REPOSITORY_NAME.test(name) &&
  name !== "." &&
  name !== "..";

/** The repository's name when `repo` is `didi-build/<name>` exactly, else null. */
export function organizationRepositoryName(repo: unknown): string | null {
  if (typeof repo !== "string") return null;
  const prefix = `${GITHUB_ORGANIZATION}/`;
  if (!repo.startsWith(prefix)) return null;
  const name = repo.slice(prefix.length);
  return isRepositoryName(name) ? name : null;
}

/** Whether a workflow run's `path` is Bootstrap's: GitHub may add `@<ref>` after the path. */
export const isBootstrapWorkflowPath = (path: unknown): boolean =>
  typeof path === "string" &&
  (path === BOOTSTRAP_WORKFLOW_PATH || path.startsWith(`${BOOTSTRAP_WORKFLOW_PATH}@`));

/** What one change to GitHub came to. `step` names where it stopped, never a token. */
export type GitHubChange =
  | { kind: "done" }
  | {
      kind: "refused";
      /**
       * `token`: the step's narrow token was not minted (refused, granted wider, or the runner
       * App does not exist yet). `not_selected`: GitHub answered that the secret is not shared
       * with selected repositories only. `call`: GitHub refused or failed the call.
       */
      step: "token" | "not_selected" | "call";
      /**
       * GitHub's HTTP status when it answered the call with something else than success, so a
       * refusal says why (O-114). An answer's status only: never its body, a token or an id.
       */
      status?: number;
    };

/**
 * The secret's list of selected repositories (GitHub's organization secret endpoints). Each
 * change mints its own token, narrowed to the one repository, with `organization_secrets: write`
 * and nothing else but GitHub's `metadata: read`. The list mints a token with
 * `organization_secrets: read`. None can read a secret's value or delete a repository.
 */
export interface BootstrapAccess {
  /** Adds `didi-build/<name>` to the list. Never tries again, with this token or another. */
  grant(name: string): Promise<GitHubChange>;
  /** Removes `didi-build/<name>` from the list. Never tries again. */
  remove(name: string): Promise<GitHubChange>;
  /** The names of the repositories on the list now. Throws on a failed read. */
  list(): Promise<string[]>;
}

/** A run of Bootstrap as GitHub shows it. */
export interface BootstrapRun {
  /** The event that started it, for example `workflow_dispatch` or `push`. */
  event: string;
  /** `queued`, `in_progress`, `completed` and GitHub's other run statuses. */
  status: string;
  /** Set once the run completed: `success`, `failure`, `cancelled` and the others. */
  conclusion: string | null;
}

export interface BootstrapRuns {
  /**
   * Starts Bootstrap on main of `didi-build/<name>`, with a token narrowed to that repository and
   * `actions: write`. Never tries again.
   */
  restart(name: string): Promise<GitHubChange>;
  /**
   * The newest run of Bootstrap on `didi-build/<name>` started by `workflow_dispatch`, or null
   * when there is none, read with the runner App's `actions: read` token. Throws on a failed read.
   */
  latestRestart(name: string): Promise<BootstrapRun | null>;
}

/** Where a project's setup is, from the newest restarted run (see "finished" above). */
export type SetupState = "not_started" | "running" | "succeeded" | "failed";

export function setupStateOf(run: BootstrapRun | null): SetupState {
  if (run === null) return "not_started";
  if (run.status !== "completed") return "running";
  return run.conclusion === "success" ? "succeeded" : "failed";
}

/** Whether setup has finished, well or not: the restarted run has completed. */
export const setupFinished = (state: SetupState): boolean =>
  state === "succeeded" || state === "failed";

/** Why the form's setup step stopped. Its fixed text is in `REGISTER_REFUSALS`. */
export type SetupRefusal =
  | "grant_token_refused"
  | "secret_not_selected"
  | "grant_refused"
  | "restart_token_refused"
  | "restart_refused";

/**
 * The form's setup step, once the project is recorded: the grant, then the restart. Each mints
 * its own token, once, and a refusal stops it; nothing is tried again, wider or not, except the
 * restart's call while GitHub answers 404 for a repository created moments ago (D-380). A refused
 * restart leaves the access for the restart a later run of the form makes, inside the window, or
 * for the backstop to remove.
 */
export async function startSetup(
  deps: { bootstrapAccess: BootstrapAccess; bootstrapRuns: BootstrapRuns },
  name: string,
): Promise<
  { started: true } | { started: false; reason: SetupRefusal; githubStatus?: number }
> {
  const grant = await deps.bootstrapAccess
    .grant(name)
    .catch((): GitHubChange => ({ kind: "refused", step: "call" }));
  if (grant.kind === "refused") {
    const reason: Record<typeof grant.step, SetupRefusal> = {
      token: "grant_token_refused",
      not_selected: "secret_not_selected",
      call: "grant_refused",
    };
    return { started: false, reason: reason[grant.step] };
  }
  const restart = await deps.bootstrapRuns
    .restart(name)
    .catch((): GitHubChange => ({ kind: "refused", step: "call" }));
  if (restart.kind === "refused") {
    return {
      started: false,
      reason: restart.step === "token" ? "restart_token_refused" : "restart_refused",
      ...(restart.status === undefined ? {} : { githubStatus: restart.status }),
    };
  }
  return { started: true };
}

type Switches = Pick<StoreOps, "getSetting">;

/** Read as every flow reads them: the kill switch is on only when true, dry run unless false. */
async function switchesOf(store: Switches): Promise<"kill_switch" | "dry_run" | null> {
  if ((await store.getSetting("kill_switch"))?.value === true) return "kill_switch";
  return (await store.getSetting("dry_run"))?.value !== false ? "dry_run" : null;
}

/** The fixed texts of the removal after Bootstrap's run. None quotes a token or the input. */
export const REMOVAL_TEXTS = {
  not_a_repository:
    "The input is not a repository of didi-build: nothing was read or removed.",
  kill_switch: "The kill switch is on: the access was not removed (N-100).",
  dry_run:
    "Dry run is on: nothing was removed. With dry run off, the repository would be removed from BOOTSTRAP_TOKEN's selected repositories.",
  token:
    "The token to change BOOTSTRAP_TOKEN's selected repositories was not minted (GitHub refused it, or the runner App is not registered yet): the access was not removed. The reconcile pass removes it.",
  not_selected:
    "GitHub answered that BOOTSTRAP_TOKEN is not shared with selected repositories only: nothing was removed. Set its repository access to selected repositories (first-hosting runbook, step 13).",
  call: "GitHub refused or failed the removal from BOOTSTRAP_TOKEN's selected repositories: the reconcile pass removes it.",
} as const;

export type RemovalResult =
  | { outcome: "removed"; repository: string }
  | {
      outcome: "refused" | "dry_run";
      reason: keyof typeof REMOVAL_TEXTS;
      message: string;
    };

/**
 * Step 2: Bootstrap's restarted run on `repo` ended, whatever its conclusion, so the repository
 * leaves the secret's list. `repo` is `didi-build/<name>`. The receiver cannot read projects, so
 * any repository of the organization is accepted: for one that is not a registered project, the
 * removal is what the backstop does anyway. The run's conclusion is not needed here: the daily
 * check and the form read it from GitHub.
 */
export async function removeAfterBootstrap(
  deps: { store: Switches; bootstrapAccess: BootstrapAccess },
  repo: unknown,
): Promise<RemovalResult> {
  const text = (
    outcome: "refused" | "dry_run",
    reason: keyof typeof REMOVAL_TEXTS,
  ): RemovalResult => ({ outcome, reason, message: REMOVAL_TEXTS[reason] });
  const name = organizationRepositoryName(repo);
  if (name === null) return text("refused", "not_a_repository");
  const held = await switchesOf(deps.store);
  if (held === "kill_switch") return text("refused", "kill_switch");
  if (held === "dry_run") return text("dry_run", "dry_run");
  const removed = await deps.bootstrapAccess
    .remove(name)
    .catch((): GitHubChange => ({ kind: "refused", step: "call" }));
  if (removed.kind === "refused") return text("refused", removed.step);
  return { outcome: "removed", repository: `${GITHUB_ORGANIZATION}/${name}` };
}

/** Why the backstop removes a repository. */
export type RemovalCause =
  /** Not the repository of a registered project, for example `foreman` or `launchpad`. */
  | "not_a_project"
  /** The project was registered `SETUP_WINDOW_MINUTES` ago or more. */
  | "window_passed"
  /** The project's restarted Bootstrap run has completed. */
  | "setup_finished"
  /** Bootstrap's runs could not be read, so the window is not shown to be open. */
  | "setup_unreadable";

export interface BackstopRemoval {
  repository: string;
  cause: RemovalCause;
  /** `would_remove` in dry run. `refused` names the step GitHub stopped at. */
  result: "removed" | "would_remove" | "refused";
  step?: "token" | "not_selected" | "call";
}

export interface BootstrapAccessPass {
  mode: "dry_run" | "live";
  /** Repositories left on the list, each inside its setup window. */
  kept: string[];
  removals: BackstopRemoval[];
  /** Set when the list could not be read: nothing was removed. */
  problem: string | null;
}

export const ACCESS_LIST_UNREADABLE =
  "BOOTSTRAP_TOKEN's selected repositories could not be read (the token was refused, or the runner App is not registered yet): nothing was removed";

const MINUTE_MS = 60_000;

/**
 * Step 3, the reconcile pass's backstop. Null under the kill switch: nothing is read or removed.
 * In dry run it lists and reports what it would remove. A failed read of Bootstrap's runs removes
 * the repository, since the window is not shown to be open (fail closed).
 */
export async function bootstrapAccessPass(deps: {
  store: Switches & Pick<StoreOps, "listProjects">;
  clock: Clock;
  bootstrapAccess: BootstrapAccess;
  bootstrapRuns: BootstrapRuns;
}): Promise<BootstrapAccessPass | null> {
  const held = await switchesOf(deps.store);
  if (held === "kill_switch") return null;
  const mode = held === "dry_run" ? "dry_run" : "live";
  const pass: BootstrapAccessPass = { mode, kept: [], removals: [], problem: null };
  let listed: string[];
  try {
    listed = await deps.bootstrapAccess.list();
  } catch {
    pass.problem = ACCESS_LIST_UNREADABLE;
    return pass;
  }
  const projects = new Map<string, Project>(
    (await deps.store.listProjects()).map((p) => [p.repo, p]),
  );
  const now = deps.clock.now().getTime();

  async function causeFor(name: string): Promise<RemovalCause | null> {
    const project = projects.get(`${GITHUB_ORGANIZATION}/${name}`);
    if (!project) return "not_a_project";
    if (now - project.createdAt.getTime() >= SETUP_WINDOW_MINUTES * MINUTE_MS)
      return "window_passed";
    let state: SetupState;
    try {
      state = setupStateOf(await deps.bootstrapRuns.latestRestart(name));
    } catch {
      return "setup_unreadable";
    }
    return setupFinished(state) ? "setup_finished" : null;
  }

  for (const name of [...new Set(listed)].sort()) {
    const repository = `${GITHUB_ORGANIZATION}/${name}`;
    const cause = await causeFor(name);
    if (cause === null) {
      pass.kept.push(repository);
      continue;
    }
    if (mode === "dry_run") {
      pass.removals.push({ repository, cause, result: "would_remove" });
      continue;
    }
    const removed = await deps.bootstrapAccess
      .remove(name)
      .catch((): GitHubChange => ({ kind: "refused", step: "call" }));
    pass.removals.push(
      removed.kind === "done"
        ? { repository, cause, result: "removed" }
        : { repository, cause, result: "refused", step: removed.step },
    );
  }
  return pass;
}

/** One project whose setup failed, as the daily check shows it. */
export interface FailedSetup {
  slug: string;
  message: string;
}

export interface SetupReport {
  /** Projects whose restarted Bootstrap run completed with a conclusion other than success. */
  failed: FailedSetup[];
  /** Slugs of the projects whose Bootstrap runs could not be read. */
  unreadable: string[];
}

export const failedSetupMessage = (slug: string): string =>
  `Bootstrap failed for ${slug}; run the register form again`;

/**
 * For the daily check: each registered project whose setup failed. Reads only. A project whose
 * repository is not `didi-build/<slug>` is not one the form set up, and is left out.
 */
export async function failedSetups(
  deps: { bootstrapRuns: Pick<BootstrapRuns, "latestRestart"> },
  projects: readonly Project[],
): Promise<SetupReport> {
  const report: SetupReport = { failed: [], unreadable: [] };
  const own = projects
    .filter((p) => organizationRepositoryName(p.repo) === p.slug)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  for (const project of own) {
    let state: SetupState;
    try {
      state = setupStateOf(await deps.bootstrapRuns.latestRestart(project.slug));
    } catch {
      report.unreadable.push(project.slug);
      continue;
    }
    if (state === "failed") {
      report.failed.push({
        slug: project.slug,
        message: failedSetupMessage(project.slug),
      });
    }
  }
  return report;
}
