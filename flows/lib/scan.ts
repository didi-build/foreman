// The Scanner's stage 1 pass (D-299, D-300, O-92): once a day, before the daily check, it scans
// every project's repository at its default branch's head in the repo map Job's scan mode
// (`repoScans`, src/adapters/agent-runtime/kubernetes/repo-maps.ts) and files the new findings as
// ideas in that project, at most 5 per scan, duplicates merged, new findings in the same file as an
// open scanner idea folded into it, and the open ideas it no longer finds cleaned up: one still in
// Submitted withdrawn to Rejected by the runner-only move, one further along recorded and asked
// about in a Council question (src/core/scan-ideas.ts, D-301, O-93). It never changes code, opens
// a PR, moves an idea further along or touches a work item. The Council question's run is started
// by the reconcile flow's Council pass, as for every open question.
//
// Switches: under the kill switch or in dry run the pass reads nothing and starts no Job, as a run
// start in dry run starts none (./start-run.ts), and the filing step reads both again in its own
// transaction and writes nothing (src/core/finding-ideas.ts). Until the runner App is registered
// (D-178) the token port refuses with `NotBuiltError` before any cluster object is made; the pass
// then records nothing and says so. Any other failure is recorded as the scan's failed step, by a
// fixed name only, so the daily check shows it; the error's own text is never kept or returned.
import { RepoMapJobError } from "../../src/adapters/agent-runtime/kubernetes/repo-maps.ts";
import { KubernetesApiError } from "../../src/adapters/agent-runtime/kubernetes/client.ts";
import { GitHubReadError } from "../../src/adapters/github/runner-app-tokens.ts";
import { ScanResultError } from "../../src/core/scan.ts";
import {
  createScanIdeas,
  type ScanFailure,
  type ScanSummary,
  type ScanWithdrawal,
} from "../../src/core/scan-ideas.ts";
import { NotBuiltError, type FlowDeps } from "./compose.ts";
import { heldBy } from "./switches.ts";

/** The scheduled flow that runs this pass (flows/windmill.yaml). */
export const SCAN_FLOW_PATH = "f/foreman/scan";

export type ProjectScanStep =
  | {
      slug: string;
      outcome: "filed";
      commitSha: string;
      summary: ScanSummary;
      /** The withdrawals of ideas in Submitted it no longer found (D-301). */
      withdrawals: ScanWithdrawal[];
    }
  | { slug: string; outcome: "failed"; failure: ScanFailure; recorded: boolean }
  /** A switch was turned on while the pass ran: nothing was written for the project. */
  | { slug: string; outcome: "held"; reason: string };

export interface ScanPassResult {
  outcome: "scanned" | "kill_switch" | "dry_run" | "not_built";
  /** Why nothing was scanned, when nothing was. */
  note: string | null;
  projects: ProjectScanStep[];
}

/** The fixed name of the step an error came from. */
function failureOf(error: unknown): ScanFailure {
  if (error instanceof GitHubReadError) return "github";
  if (error instanceof KubernetesApiError) return "cluster";
  if (error instanceof RepoMapJobError) return "job";
  if (error instanceof ScanResultError) return "result";
  return "other";
}

export async function scanPass(deps: FlowDeps): Promise<ScanPassResult> {
  const held = await heldBy(deps.store);
  if (held === "kill_switch") {
    return {
      outcome: held,
      note: "The kill switch is on: no scan ran and nothing was recorded.",
      projects: [],
    };
  }
  if (held === "dry_run") {
    return {
      outcome: held,
      note: "Dry run is on: no scan ran and nothing was recorded.",
      projects: [],
    };
  }
  const filing = createScanIdeas(deps);
  const steps: ProjectScanStep[] = [];
  for (const project of await deps.store.listProjects()) {
    let scan;
    try {
      scan = await deps.repoScans.scan({ slug: project.slug, repo: project.repo });
    } catch (error) {
      if (error instanceof NotBuiltError) {
        return {
          outcome: "not_built",
          note: `No scan ran and nothing was recorded: ${error.message}`,
          projects: steps,
        };
      }
      const failure = failureOf(error);
      const recorded = await filing.recordFailure(project.id, failure);
      steps.push({
        slug: project.slug,
        outcome: "failed",
        failure,
        recorded: recorded.step === "recorded",
      });
      continue;
    }
    const filed = await filing.file(project.id, scan);
    steps.push(
      filed.step === "filed"
        ? {
            slug: project.slug,
            outcome: "filed",
            commitSha: scan.commitSha,
            summary: filed.summary,
            withdrawals: filed.withdrawals,
          }
        : { slug: project.slug, outcome: "held", reason: filed.reason },
    );
  }
  return { outcome: "scanned", note: null, projects: steps };
}
