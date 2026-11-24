// The runner's read of the site QA will browse (ADR 0119 slice 5a, D-476 to D-480, O-174): the
// core's `QaSites` (src/core/qa-site.ts). Each read mints a read-only installation token of the
// runner App that carries only `actions: read` for that one repository (./runner-app-tokens.ts),
// uses it for that read and never keeps or logs it. No permission or webhook event is added:
// D-267 gave the runner App `actions: read`, as for the screenshot bundles and the staging site.
//
// `read(repo, workflowRunId)`: the artifacts of exactly the preview check's run named `qa-site`
// (`GET /repos/{repo}/actions/runs/{run_id}/artifacts?name=qa-site`), the newest unexpired one,
// downloaded as GitHub's zip (`GET /repos/{repo}/actions/artifacts/{id}/zip`), with the listing,
// choice and download code the screenshot bundles and the staging deploy share
// (../screenshots/github-artifacts.ts). The run id is the one the runner recorded with the head's
// `preview_check` (`PreviewCheckResult.workflowRunId`), so no other run or workflow is looked in.
//
// The zip is refused over `QA_SITE_MAX_ZIP_BYTES` (900 KiB) twice: before the download, by the
// size GitHub lists for it, and after, by the bytes that came; the download itself is bounded to
// it, so a larger body is cut off by the HTTP port and counts as a refused download. Then the zip
// is read in memory within `QA_SITE_LIMITS` by the reader the staging deploy uses
// (../deploy/site-files.ts `readSiteEntries`), and the core checks the entries.
//
// A listing or a download GitHub refuses (`GitHubReadError`: a status other than 200, or a body
// over its bound) is no site, `download_refused`, so QA reviews without the browser and says why
// (D-479). A repository name or run id out of shape is the caller's mistake and throws before any
// token is minted; so does any other error, such as a failure to mint the token. Fixed reasons
// only: nothing from GitHub's answer or the build is returned as text. Tests pass fakes.
import {
  QA_SITE_ARTIFACT,
  QA_SITE_LIMITS,
  QA_SITE_MAX_ZIP_BYTES,
} from "../../core/qa-site.ts";
import type { QaSiteRead, QaSiteReadRefusal, QaSites } from "../../core/qa-site.ts";
import { readSiteEntries } from "../deploy/site-files.ts";
import {
  downloadArtifact,
  listRunArtifacts,
  newestArtifact,
} from "../screenshots/github-artifacts.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** A folder entry counts in the zip but is no file; this leaves room for one per file. */
const ZIP_ENTRY_BOUND = QA_SITE_LIMITS.files * 2;

const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const none = (reason: QaSiteReadRefusal): QaSiteRead => ({ found: false, reason });

/** The call's answer, or null when GitHub refused it or broke a bound. */
async function orRefused<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GitHubReadError) return null;
    throw error;
  }
}

export interface GitHubQaSitesOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubQaSites({ tokens, http }: GitHubQaSitesOptions): QaSites {
  return {
    async read(repo, workflowRunId) {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      if (!isId(workflowRunId)) throw new GitHubReadError("not a workflow run id");
      // Minted for this read only, with actions read on this repository only (D-267).
      const token = await tokens.mint({ repository: repo, permission: "actions" });

      const listed = await orRefused(() =>
        listRunArtifacts(http, {
          repo,
          runId: workflowRunId,
          name: QA_SITE_ARTIFACT,
          token,
        }),
      );
      if (listed === null) return none("download_refused");
      const found = newestArtifact(listed, QA_SITE_ARTIFACT);
      if (!found) return none("missing");
      if (found.sizeInBytes !== null && found.sizeInBytes > QA_SITE_MAX_ZIP_BYTES) {
        return none("zip_too_large");
      }

      const zip = await orRefused(() =>
        downloadArtifact(http, {
          repo,
          id: found.id,
          token,
          maxBytes: QA_SITE_MAX_ZIP_BYTES,
        }),
      );
      if (zip === null) return none("download_refused");
      if (zip.length > QA_SITE_MAX_ZIP_BYTES) return none("zip_too_large");

      const read = readSiteEntries(zip, {
        entries: ZIP_ENTRY_BOUND,
        entryBytes: QA_SITE_LIMITS.fileBytes,
        totalBytes: QA_SITE_LIMITS.totalBytes,
      });
      if (!read.ok) return none(read.reason);
      return { found: true, zip, entries: read.entries };
    },
  };
}
