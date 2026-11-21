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
// Later slices add, each answering done or refused with fixed text and never throwing for a
// refusal: `setUp(project)` (slices 4 and 6), and `setSecret(project, name, value)` and
// `secretNames(project)` (slice 7), never returning a value. ADR 0111's `health`, `logs` and
// `teardown` stay unbuilt.
import type { DeployTargetName } from "./project-entry.ts";
import type { StagingTarget } from "./staging-deploy.ts";

/**
 * A deploy target: its name (`cloudflare` or `cluster`, as a project file names it, ADR 0118
 * appendix A), and today's staging deploy.
 */
export interface DeployTarget extends StagingTarget {
  readonly name: DeployTargetName;
}
