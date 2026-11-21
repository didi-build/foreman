// The deploy target port (ADR 0118 appendix G, D-441, O-159): where a project's product runs.
// Today's staging deploy (`StagingTarget`, ./staging-deploy.ts) is its first operation, unchanged;
// the port adds the target's name, so the composition can hold more than one target and pick a
// project's by name. No Cloudflare or cluster type appears here (AGENTS.md section 3).
//
// - `cloudflare` (src/adapters/deploy/cloudflare-staging.ts): every project today, and every new
//   project by default (D-441). Its `deploy` takes the build in the old layout (assets only, as the
//   rehearsal builds it) exactly as before, or in the new one with a Worker module (O-159).
// - `cluster`: Foreman itself, from slice 9, which also routes each project to its target. Until
//   then the store records no target (slice 6 adds the column), so every project's is `cloudflare`.
//
// Slice 4 (O-160) adds the operations a new project and its secrets need, each answering done or
// refused with fixed text and never throwing for a refusal, and none ever returning a secret's
// value or the database's id:
// - `setUp`: what a new project needs on the target before its name and route are made, each part
//   found before it is created (ADR 0118 appendix C, steps 1 and 2): its staging database, then a
//   placeholder product that answers at `/` and `/api/health` (D-438). Slice 6's form calls it.
// - `putSecret` and `listSecretNames`: a product secret on the project's staging product only
//   (D-440), and the names of those set. Slice 7's form and deploy check call them.
// ADR 0111's `health`, `logs` and `teardown` stay unbuilt.
import type { DeployTargetName } from "./project-entry.ts";
import type { DeployRefusalDetail, StagingTarget } from "./staging-deploy.ts";

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

/**
 * A deploy target: its name (`cloudflare` or `cluster`, as a project file names it, ADR 0118
 * appendix A), today's staging deploy, a new project's setup and its product secrets.
 */
export interface DeployTarget extends StagingTarget {
  readonly name: DeployTargetName;
  setUp(request: ProjectSetUpRequest): Promise<ProjectSetUp>;
  /** The value is sent once, to the target, and never logged, kept or returned. */
  putSecret(slug: string, name: string, value: string): Promise<SecretPut>;
  listSecretNames(slug: string): Promise<SecretNames>;
}
