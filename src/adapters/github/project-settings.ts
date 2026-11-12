// The slugs a project may be registered with (src/core/register-project.ts `ProjectSettings`,
// D-345, O-109): `projects[].slug` of the platform settings file
// `infra/kubernetes/settings/production.json` as merged on `didi-build/foreman`'s main.
//
// Nothing else reads a repository file at run time: a flow's bundle carries `contracts/` from the
// commit it was built from, which can be older than main. So the form reads the file from GitHub,
// `GET /repos/didi-build/foreman/contents/<path>?ref=main`, with the runner App's read-only
// `contents` token minted for `didi-build/foreman` only (D-267), the same minting the repo map and
// the visibility check use. The file holds no secret (runbook step 7).
//
// The runner mints the token with its App's key (flows/lib/compose.ts, O-125); a refused token
// makes the form refuse on the settings. Tests pass fakes.
import {
  PLATFORM_SETTINGS,
  type ProjectSettings,
} from "../../core/register-project.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** The largest contents answer the runner reads: GitHub serves base64 content up to 1 MiB. */
const MAX_SETTINGS_ANSWER_BYTES = 2 * 1024 * 1024;

export interface GitHubProjectSettingsOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The listed slugs from the settings file's text. Throws, naming the problem, on any other shape. */
export function listedSlugsOf(text: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new GitHubReadError("the settings file is not JSON");
  }
  if (!isObject(settings) || !Array.isArray(settings.projects)) {
    throw new GitHubReadError("the settings file has no projects list");
  }
  return settings.projects.map((project) => {
    if (!isObject(project) || typeof project.slug !== "string") {
      throw new GitHubReadError("a project in the settings file has no slug");
    }
    return project.slug;
  });
}

export function createGitHubProjectSettings({
  tokens,
  http,
}: GitHubProjectSettingsOptions): ProjectSettings {
  return {
    async listedSlugs() {
      const { repository, path, ref } = PLATFORM_SETTINGS;
      // Minted for this read only, with contents read on didi-build/foreman only (D-267).
      const token = await tokens.mint({ repository, permission: "contents" });
      const answer = await http.get({
        path: `/repos/${repository}/contents/${path}?ref=${ref}`,
        token,
        accept: "json",
        maxBytes: MAX_SETTINGS_ANSWER_BYTES,
      });
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading the settings file failed with ${answer.status}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(answer.body).toString("utf8"));
      } catch {
        throw new GitHubReadError("the contents answer is not JSON");
      }
      if (
        !isObject(body) ||
        body.type !== "file" ||
        body.path !== path ||
        body.encoding !== "base64" ||
        typeof body.content !== "string"
      ) {
        throw new GitHubReadError("the contents answer is not the settings file");
      }
      return listedSlugsOf(Buffer.from(body.content, "base64").toString("utf8"));
    },
  };
}
