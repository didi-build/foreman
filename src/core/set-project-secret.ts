// Didi's Set project secret form (ADR 0118 appendix D, D-440, O-163). The called flow
// `f/foreman/set_project_secret` (flows/set-project-secret.ts) takes three boxes: the project's
// short name, the secret's name and its value. The value box is a Windmill password field (the
// Windmill deploy sends this one form's schema): as Didi types, Windmill saves the value as a
// short-lived secret variable under Didi's user, set to expire 7 days later, and the run's arguments
// hold only a reference to it. The worker reads the variable with the job's own token and hands the
// value to the form.
//
// In order:
// 1. The kill switch refuses before anything is read, set or deleted. The short-lived variable
//    then expires on its own.
// 2. The short-lived variable: its path, read from this run's own record (the value argument), is
//    deleted at once, since the form holds the value now, so it goes whatever happens next, in dry
//    run too. If the run cannot be read, or Windmill does not delete the variable, nothing else
//    changes and the answer says the variable expires on its own 7 days after it was made. If the
//    run's value argument is not a reference to such a variable (the value as typed, or a
//    reference to another variable, whose value the job's token could read), the form refuses
//    before any check and sets nothing.
// 3. The checks: the project's short name; the secret's name (1 to 64 uppercase letters, digits
//    or underscores, a letter first, and not DB or ASSETS, the bindings Foreman sets); the value
//    (not empty, at most 5 KiB, Cloudflare's limit for a Worker variable); and the project in the
//    store with the Cloudflare target (migration 0028).
// 4. Dry run stops here, and says what the form would set.
// 5. Both switches again, then the value on the project's staging Worker `<slug>-staging` through
//    the deploy target's `putSecret` (O-160): the staging Worker only, never a preview (D-440).
// 6. The name and the time go into factory.project_secret_names (migration 0030), append-only,
//    with the Windmill run's id when it is a UUID.
//
// What Didi sees: `set`, `dry_run` or `refused`; the project and the secret's name, each once it
// has passed its check; what happened to the short-lived variable; and what to do next. Never the
// value: it is in no result, refusal, record or error, and nothing here logs.
import {
  isProductSecretName,
  isProductSecretValue,
  projectTargetOf,
  type ProjectTarget,
  type SecretPut,
} from "./deploy-target.ts";
import type { Clock, IdSource } from "./library.ts";
import type { DeployTargetName } from "./project-entry.ts";
import { PROJECT_SLUG } from "./project-repository.ts";
import { DEPLOY_REFUSALS, type DeployRefusalDetail } from "./staging-deploy.ts";
import type { Store } from "./store.ts";

/** The form's argument that holds the value: `main`'s parameter, and the password field. */
export const VALUE_ARGUMENT = "value";

/** Who records a secret's name (migration 0030). */
export const SET_PROJECT_SECRET_RECORDER = "runner:set-project-secret";

/** What this run's own record says the value argument holds. */
export type ShortLivedVariableFind =
  /** A reference to a short-lived secret variable of the password field, at this path. */
  | { kind: "variable"; path: string }
  /** The value as typed, or a reference to anything else: no short-lived variable. */
  | { kind: "not_a_reference" }
  /** The run's record could not be read; `status` is Windmill's answer when there was one. */
  | { kind: "unreadable"; status?: number };

/** What the deletion of the short-lived variable came to. */
export type ShortLivedVariableRemoval =
  { removed: true } | { removed: false; status?: number };

/**
 * The short-lived secret variable the form's password field made for the value (ADR 0118
 * appendix D), read and deleted with the job's own token. Neither call ever returns, logs or
 * throws with the value, and neither throws for an answer it does not expect.
 */
export interface ShortLivedVariables {
  /** The variable behind `argument` of this run, read from the run's own record. */
  find(argument: string): Promise<ShortLivedVariableFind>;
  /** Deletes exactly the variable at `path`, as `find` gave it. */
  remove(path: string): Promise<ShortLivedVariableRemoval>;
}

export interface SetProjectSecretDeps {
  store: Pick<Store, "getSetting" | "getProjectBySlug" | "insertProjectSecretName">;
  clock: Clock;
  ids: IdSource;
  /**
   * The deploy targets by name (O-166): the project's row picks one. The form takes only a
   * Cloudflare-target project (`not_cloudflare`), whose secret put is on `<slug>-staging` only
   * (O-160); the cluster target refuses a put anyway.
   */
  targets: { readonly [name in DeployTargetName]: Pick<ProjectTarget, "putSecret"> };
  shortLivedVariables: ShortLivedVariables;
}

export interface SetProjectSecretInput {
  /** The project's short name. */
  project: string;
  /** The secret's name, as the Worker reads it. */
  name: string;
  /** The value, as the worker read it from the short-lived variable. Never logged or kept. */
  value: string;
  /** The Windmill run's id, recorded with the name. Left out when not a UUID. */
  runId?: string | null;
}

/** Every refusal, with its fixed text. None quotes the input. */
export const SET_PROJECT_SECRET_REFUSALS = {
  kill_switch:
    "The kill switch is on: nothing was read, set, recorded or deleted. Run the form again once it is off.",
  not_a_reference:
    "The value box did not hold a reference to a short-lived secret variable of its password field, but the value as typed or a reference to another variable: nothing was set. If it held a real value, treat that value as seen by anyone who can see this run and replace it where it was made, then check that the form's page shows the value box as a password field (first-hosting runbook, The Set project secret form's first real run).",
  invalid_project:
    "The project must be a short name of lowercase letters, digits and hyphens: nothing was set.",
  invalid_name:
    "The secret's name must be 1 to 64 uppercase letters, digits or underscores, start with a letter, and not be DB or ASSETS, the bindings Foreman sets: nothing was set.",
  invalid_value:
    "The value must not be empty and must be at most 5 KiB (5,120 bytes of UTF-8), Cloudflare's limit for a Worker variable: nothing was set.",
  not_a_project:
    "The store has no project with this short name: nothing was set. A product secret goes only on a registered project's staging Worker.",
  not_cloudflare:
    "The project's deploy target is not Cloudflare, so it has no staging Worker to hold a product secret: nothing was set.",
  switch_turned_on:
    "The kill switch or dry run was turned on while the form ran: nothing was set. Run the form again once both are off.",
  put_refused:
    "The secret could not be put on the project's staging Worker (target names the deploy target's fixed reason; cloudflare, when present, names the call, its status and Cloudflare's codes): nothing was set or recorded. Fix what they name, then run the form again with the value.",
} as const;

export type SetProjectSecretRefusal = keyof typeof SET_PROJECT_SECRET_REFUSALS;

/** The fixed text of each outcome that is not a refusal. */
export const SET_PROJECT_SECRET_MESSAGES = {
  set: "The secret is on the project's staging Worker and its name is recorded. Foreman keeps no copy of the value, and this answer holds none.",
  dry_run:
    "Dry run is on: nothing was set or recorded. With dry run off, the form would put this secret on the project's staging Worker and record its name.",
} as const;

/** What happened to the short-lived secret variable the value box made. */
export type ShortLivedVariableStep =
  "deleted" | "not_deleted" | "unread" | "none" | "not_reached";

export const SHORT_LIVED_VARIABLE_TEXTS: Record<ShortLivedVariableStep, string> = {
  deleted:
    "The short-lived secret variable Windmill made for the value is deleted: this run's arguments hold only a reference to it.",
  not_deleted:
    "Windmill did not delete the short-lived secret variable it made for the value (windmillStatus, when present, is its answer): it expires on its own 7 days after it was made.",
  unread:
    "This run's own record could not be read, so the short-lived secret variable Windmill made for the value was not deleted: it expires on its own 7 days after it was made.",
  none: "The value box held no short-lived secret variable, so none was deleted.",
  not_reached:
    "The kill switch stopped the form before it read anything, so the short-lived secret variable Windmill made for the value was not deleted: it expires on its own 7 days after it was made.",
};

export interface SetProjectSecretResult {
  outcome: "set" | "dry_run" | "refused";
  message: string;
  /** Set when refused. */
  reason?: SetProjectSecretRefusal;
  /** The project's short name, once it has passed its check. */
  project?: string;
  /** The secret's name, once it has passed its check. Never the value. */
  name?: string;
  /** For `put_refused`: the deploy target's fixed reason and text (O-160). Never a value. */
  target?: { reason: string; text: string };
  /** For `put_refused`: Cloudflare's call, status and codes (O-139). Never its message. */
  cloudflare?: DeployRefusalDetail;
  /** What happened to the short-lived secret variable. */
  shortLivedVariable: {
    step: ShortLivedVariableStep;
    text: string;
    /** Windmill's status when it answered a read or a delete it did not do. */
    windmillStatus?: number;
  };
  /** What to do next. */
  next: string[];
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createSetProjectSecretForm(deps: SetProjectSecretDeps) {
  const { store, clock, ids } = deps;

  const killSwitchOn = async () =>
    (await store.getSetting("kill_switch"))?.value === true;
  // A missing setting means dry run, as in the library.
  const dryRunOn = async () => (await store.getSetting("dry_run"))?.value !== false;

  /**
   * Step 2: the short-lived variable found in this run's record and deleted. `not_a_reference`
   * when the value argument held none and the value is not empty (an empty value holds none, and
   * the value check refuses it).
   */
  async function removeShortLivedVariable(
    value: unknown,
  ): Promise<SetProjectSecretResult["shortLivedVariable"] | "not_a_reference"> {
    const found = await deps.shortLivedVariables
      .find(VALUE_ARGUMENT)
      .catch((): ShortLivedVariableFind => ({ kind: "unreadable" }));
    const step = (
      s: ShortLivedVariableStep,
      status?: number,
    ): SetProjectSecretResult["shortLivedVariable"] => ({
      step: s,
      text: SHORT_LIVED_VARIABLE_TEXTS[s],
      ...(status === undefined ? {} : { windmillStatus: status }),
    });
    if (found.kind === "unreadable") return step("unread", found.status);
    if (found.kind === "not_a_reference") {
      return value === "" ? step("none") : "not_a_reference";
    }
    const removal = await deps.shortLivedVariables
      .remove(found.path)
      .catch((): ShortLivedVariableRemoval => ({ removed: false }));
    return removal.removed ? step("deleted") : step("not_deleted", removal.status);
  }

  return {
    async set(input: SetProjectSecretInput): Promise<SetProjectSecretResult> {
      // 1. The kill switch, before anything is read.
      if (await killSwitchOn()) {
        return {
          outcome: "refused",
          reason: "kill_switch",
          message: SET_PROJECT_SECRET_REFUSALS.kill_switch,
          shortLivedVariable: {
            step: "not_reached",
            text: SHORT_LIVED_VARIABLE_TEXTS.not_reached,
          },
          next: [],
        };
      }

      // 2. The short-lived variable, deleted at once.
      const variable = await removeShortLivedVariable(input?.value);
      if (variable === "not_a_reference") {
        return {
          outcome: "refused",
          reason: "not_a_reference",
          message: SET_PROJECT_SECRET_REFUSALS.not_a_reference,
          shortLivedVariable: { step: "none", text: SHORT_LIVED_VARIABLE_TEXTS.none },
          next: [],
        };
      }
      const shown: Pick<SetProjectSecretResult, "project" | "name"> = {};
      const refuse = (
        reason: SetProjectSecretRefusal,
        extra: Pick<SetProjectSecretResult, "target" | "cloudflare"> = {},
      ): SetProjectSecretResult => ({
        outcome: "refused",
        reason,
        message: SET_PROJECT_SECRET_REFUSALS[reason],
        ...shown,
        ...extra,
        shortLivedVariable: variable,
        next: ["Fix what the message names, then run the form again with the value."],
      });

      // 3. The checks. A box is shown back only once it has passed its rule.
      const slug: unknown = input?.project;
      if (typeof slug !== "string" || !PROJECT_SLUG.test(slug))
        return refuse("invalid_project");
      shown.project = slug;
      const name: unknown = input?.name;
      if (!isProductSecretName(name)) return refuse("invalid_name");
      shown.name = name;
      const value: unknown = input?.value;
      if (!isProductSecretValue(value)) return refuse("invalid_value");
      const project = await store.getProjectBySlug(slug);
      if (project === null) return refuse("not_a_project");
      if (project.deployTarget !== "cloudflare") return refuse("not_cloudflare");

      // 4. Dry run.
      if (await dryRunOn()) {
        return {
          outcome: "dry_run",
          message: SET_PROJECT_SECRET_MESSAGES.dry_run,
          ...shown,
          shortLivedVariable: variable,
          next: [
            `Turn dry run off and run the form again to put ${name} on ${slug}-staging: the password field takes the value again.`,
          ],
        };
      }

      // 5. The switches again, then the value on the staging Worker.
      if ((await killSwitchOn()) || (await dryRunOn()))
        return refuse("switch_turned_on");
      const put: SecretPut = await projectTargetOf(deps.targets, project)
        .putSecret(slug, name, value)
        .catch((): SecretPut => ({
          outcome: "refused",
          reason: "target_error",
          text: DEPLOY_REFUSALS.target_error,
        }));
      if (put.outcome !== "put") {
        return refuse("put_refused", {
          target: { reason: put.reason, text: put.text },
          ...(put.detail ? { cloudflare: put.detail } : {}),
        });
      }

      // 6. The name and the time, once the secret is on the Worker.
      await store.insertProjectSecretName({
        id: ids.next(),
        projectId: project.id,
        name,
        setAt: clock.now(),
        windmillRunId:
          typeof input.runId === "string" && RUN_ID.test(input.runId)
            ? input.runId
            : null,
        recordedBy: SET_PROJECT_SECRET_RECORDER,
      });
      return {
        outcome: "set",
        message: SET_PROJECT_SECRET_MESSAGES.set,
        ...shown,
        shortLivedVariable: variable,
        next: [
          `Every later staging deploy of ${slug} keeps ${name} on the Worker. A deploy held because ${name} was missing (D-448) goes through on the reconcile pass's next run.`,
          "To change the value, run the form again with the same name: the new value replaces the old one.",
        ],
      };
    },
  };
}

export type SetProjectSecretForm = ReturnType<typeof createSetProjectSecretForm>;
