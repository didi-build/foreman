// The deploy target port (ADR 0118 appendix G, D-441, O-159): where a project's product runs.
// Each target answers to its name, `cloudflare` or `cluster`, as a project file and the store's
// project row name it (`deployTarget`, migration 0028). The composition gives each target to the
// core by name (`DeployTargets`), and a project's row picks the one its deploy, setup and secrets
// go to (slice 9, O-166). No Cloudflare, cluster or Kubernetes type appears here (AGENTS.md
// section 3).
//
// - `cloudflare` (src/adapters/deploy/cloudflare-staging.ts): every project the New project form
//   records (D-435, D-441). Its `deploy` (`StagingTarget`, ./staging-deploy.ts) takes CI's
//   `staging-site` build in the old layout (assets only, as the rehearsal builds it) exactly as
//   before, or in the new one with a Worker module (O-159), whose new D1 migrations it applies to
//   the project's staging database before the upload (O-165).
// - `cluster` (src/adapters/deploy/cluster-target.ts): Foreman itself (appendix G). It never
//   applies anything to the cluster (D-340) and never calls Cloudflare. Its `deploy` takes no
//   build: it reads the Images workflow's run for the merged commit and answers that the commit's
//   images were built and wait for Didi's Platform apply of the new pins (`awaiting_apply`), or
//   refuses with fixed text. A release of Foreman is production (D-007), so a cluster-target item
//   is Done at merge (D-449, ./staging.ts) and the daily check shows the waiting upgrade
//   (./cluster-release.ts).
//
// Slice 4 (O-160) adds the operations a new project and its secrets need, each answering done or
// refused with fixed text and never throwing for a refusal, and none ever returning a secret's
// value or the database's id:
// - `setUp`: what a new project needs on the target before its name and route are made, each part
//   found before it is created (ADR 0118 appendix C, steps 1 and 2): its staging database, then a
//   placeholder product that answers at `/` and `/api/health` (D-438). Slice 6's form calls it.
// - `putSecret` and `listSecretNames`: a product secret on the project's staging product only
//   (D-440), and the names of those set. The Set project secret form (./set-project-secret.ts)
//   and the staging deploy's required-secret check (./staging-deploy.ts, D-448) call them (O-163).
// The cluster target refuses all three with fixed text: Didi writes Foreman's project file, and
// Foreman's own secrets go through the Platform workflow's cluster Secrets job (appendix G).
// ADR 0111's `health`, `logs` and `teardown` stay unbuilt.
//
// The product secret rules live here, so the form, the build's manifest and the target read the
// same ones (ADR 0118 appendix D, step 2).
import type { DeployTargetName } from "./project-entry.ts";
import type {
  DeployRefusalDetail,
  StagingRefusal,
  StagingTarget,
} from "./staging-deploy.ts";
import type { Project } from "./store.ts";

/** A product secret's name: 1 to 64 uppercase letters, digits or underscores, a letter first. */
export const PRODUCT_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The bindings Foreman sets on a project's Worker, which no secret may shadow. */
export const RESERVED_BINDING_NAMES: readonly string[] = ["DB", "ASSETS"];

/** The largest product secret value, in UTF-8 bytes ("Workers platform limits": 5 KB a variable). */
export const PRODUCT_SECRET_VALUE_MAX_BYTES = 5 * 1024;

/** A product secret's name: the rule above, and not a binding Foreman sets. */
export const isProductSecretName = (name: unknown): name is string =>
  typeof name === "string" &&
  PRODUCT_SECRET_NAME.test(name) &&
  !RESERVED_BINDING_NAMES.includes(name);

/** A product secret's value: not empty, and at most 5 KiB of UTF-8. Never logged or kept. */
export const isProductSecretValue = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  new TextEncoder().encode(value).byteLength <= PRODUCT_SECRET_VALUE_MAX_BYTES;

/** A refusal: a short fixed code, fixed text, and where it came from (O-139). Never a value. */
export interface TargetRefusal {
  outcome: "refused";
  reason: string;
  text: string;
  detail?: DeployRefusalDetail;
}

/** What the New project form hands the target (ADR 0118 appendix C). */
export interface ProjectSetUpRequest {
  slug: string;
  /** The project file's display name and purpose, shown on the placeholder page (D-438). */
  displayName: string;
  purpose: string;
  /** The form's dry run: only reads, and says what each step would do. */
  dryRun?: boolean;
}

/** Each step's result: found or made, or in a dry run what it would do. */
export type DatabaseStep = "found" | "created" | "would_create";
export type PlaceholderStep = "kept" | "uploaded" | "would_upload";

export type ProjectSetUp =
  | {
      outcome: "set_up" | "dry_run";
      database: DatabaseStep;
      /** `kept`: the product exists already, so a real build is never replaced. */
      placeholder: PlaceholderStep;
    }
  | (TargetRefusal & {
      /** The step refused; after the database step passed, what it did. */
      step: "check" | "database" | "placeholder";
      database?: DatabaseStep;
    });

/** A secret put on the project's staging product: its name only, never its value. */
export type SecretPut = { outcome: "put"; name: string } | TargetRefusal;

/** The names of the product secrets set on the project's staging product, never a value. */
export type SecretNames = { outcome: "listed"; names: string[] } | TargetRefusal;

/** What every target answers besides its deploy: a new project's setup and product secrets. */
export interface ProjectTarget {
  readonly name: DeployTargetName;
  setUp(request: ProjectSetUpRequest): Promise<ProjectSetUp>;
  /** The value is sent once, to the target, and never logged, kept or returned. */
  putSecret(slug: string, name: string, value: string): Promise<SecretPut>;
  listSecretNames(slug: string): Promise<SecretNames>;
}

/**
 * A deploy target that deploys CI's `staging-site` build (`cloudflare`): its name, today's staging
 * deploy, a new project's setup and its product secrets.
 */
export interface DeployTarget extends StagingTarget, ProjectTarget {}

/**
 * The cluster target's answer (ADR 0118 appendix G, D-449): the Images workflow built the merged
 * commit's images, and they wait for Didi's Platform apply of the new pins. The run is named by
 * its id, which GitHub shows in the run's address; no image reference or digest is carried.
 */
export interface ReleaseWaiting {
  outcome: "awaiting_apply";
  images: { runId: number };
}

/** What the cluster target's deploy answers: the release waiting, or a refusal with fixed text. */
export type ClusterDeploy = ReleaseWaiting | StagingRefusal;

/**
 * Foreman's own cluster target (`cluster`). Its deploy takes no build and applies nothing: it
 * reads which images the Images workflow built for the commit (appendix G). Its setup and
 * secret operations refuse with fixed text.
 */
export interface ClusterDeployTarget extends ProjectTarget {
  deploy(request: { project: Project; commitSha: string }): Promise<ClusterDeploy>;
}

/** Every deploy target by its name, as the composition gives them to the core (D-441). */
export interface DeployTargets {
  readonly cloudflare: DeployTarget;
  readonly cluster: ClusterDeployTarget;
}

/**
 * The target a project's store row names, for what every target answers alike: setup and
 * product secrets.
 */
export function projectTargetOf<T>(
  targets: { readonly [name in DeployTargetName]: T },
  project: Pick<Project, "deployTarget">,
): T {
  return targets[project.deployTarget];
}
