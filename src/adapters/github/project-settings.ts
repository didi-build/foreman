// The slugs a project may be registered with (src/core/register-project.ts `ProjectSettings`,
// D-345, O-109): the project files of the settings repository `didi-build/foreman-projects` on its
// main (D-377, D-442, ADR 0118 appendix A), `projects/<slug>.json`, one per project.
//
// Nothing else reads a repository file at run time: a flow's bundle carries `contracts/` from the
// commit it was built from, which can be older than main. So the form lists the folder from
// GitHub, `GET /repos/didi-build/foreman-projects/contents/projects?ref=main`, with the runner
// App's read-only `contents` token minted for `didi-build/foreman-projects` only (D-267), the same
// minting the repo map and the visibility check use. The repository is public and holds no secret.
// The file names are the slugs: each must be `<slug>.json` with a slug the entry rules accept
// (src/core/project-entry.ts), and anything else in the folder stops the read, as it stops the
// Platform workflow's render. The files' contents are checked by that render.
//
// The runner mints the token with its App's key (flows/lib/compose.ts, O-125); a refused token
// makes the form refuse on the settings. Tests pass fakes.
import {
  PROJECTS_BRANCH,
  PROJECTS_FOLDER,
  PROJECTS_REPOSITORY,
  isProjectEntrySlug,
} from "../../core/project-entry.ts";
import type { ProjectSettings } from "../../core/register-project.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** The largest contents answer the runner reads; GitHub lists at most 1,000 files in a folder. */
const MAX_LISTING_ANSWER_BYTES = 2 * 1024 * 1024;

export interface GitHubProjectSettingsOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The listed slugs from GitHub's contents answer for the `projects/` folder, sorted. Throws,
 * naming the problem, on any other shape or on an entry that is not a project file.
 */
export function listedSlugsOf(answer: unknown): string[] {
  if (!Array.isArray(answer)) {
    throw new GitHubReadError("the contents answer is not the projects folder");
  }
  return answer
    .map((item) => {
      if (
        !isObject(item) ||
        item.type !== "file" ||
        typeof item.name !== "string" ||
        item.path !== `${PROJECTS_FOLDER}/${item.name}`
      ) {
        throw new GitHubReadError(
          "the projects folder holds an entry that is not a file",
        );
      }
      const slug = item.name.endsWith(".json")
        ? item.name.slice(0, -".json".length)
        : "";
      if (!isProjectEntrySlug(slug)) {
        throw new GitHubReadError(
          "the projects folder holds a file that is not <slug>.json",
        );
      }
      return slug;
    })
    .sort();
}

export function createGitHubProjectSettings({
  tokens,
  http,
}: GitHubProjectSettingsOptions): ProjectSettings {
  return {
    async listedSlugs() {
      // Minted for this read only, with contents read on didi-build/foreman-projects only (D-267).
      const token = await tokens.mint({
        repository: PROJECTS_REPOSITORY,
        permission: "contents",
      });
      const answer = await http.get({
        path: `/repos/${PROJECTS_REPOSITORY}/contents/${PROJECTS_FOLDER}?ref=${PROJECTS_BRANCH}`,
        token,
        accept: "json",
        maxBytes: MAX_LISTING_ANSWER_BYTES,
      });
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading the projects folder failed with ${answer.status}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(answer.body).toString("utf8"));
      } catch {
        throw new GitHubReadError("the contents answer is not JSON");
      }
      return listedSlugsOf(body);
    },
  };
}
