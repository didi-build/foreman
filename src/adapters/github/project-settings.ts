// The New project form's settings (src/core/new-project.ts `ProjectSettings`, ADR 0118 appendix A
// and C, D-436, D-442, D-443, O-161), on GitHub's REST API. Nothing else reads a repository file
// at run time: a flow's bundle carries `contracts/` from the commit it was built from, which can
// be older than main, so the form reads both files from GitHub at main.
//
// - `standardQuota`: Foreman's own settings file, `GET /repos/didi-build/foreman/contents/
//   infra/kubernetes/settings/production.json?ref=main`, with the runner App's read-only
//   `contents` token minted for `didi-build/foreman` only (D-267): its `projectStandardQuota`,
//   checked as a quota in full (`parseProjectQuota`, src/core/project-entry.ts), is the size the
//   new file carries and the one the add-only rule compares against (D-436, O-158).
// - `readFile`: `GET /repos/didi-build/foreman-projects/contents/projects/<slug>.json?ref=main`
//   (404: no file), then the newest commit on main that changed it, `GET /repos/didi-build/
//   foreman-projects/commits?sha=main&path=projects/<slug>.json&per_page=1`, both with one
//   `contents` read token minted for `didi-build/foreman-projects` only. The repository is public
//   and holds no secret.
// - `createFile`: GitHub's "Create or update file contents", `PUT /repos/didi-build/
//   foreman-projects/contents/projects/<slug>.json` with exactly `{"message", "content" (base64),
//   "branch": "main"}` and no `sha`, with the settings write token (./settings-write-tokens.ts)
//   minted for this one call. GitHub needs the file's sha to replace a file, so without one the
//   write can only create (appendix A): 201 is the new commit. 409 and 422, which GitHub gives
//   when the file is already there or main moved, are answered as not created, so the form reads
//   the file again; nothing is ever sent with a `sha`, and nothing is tried again. Which of the
//   two GitHub answers for a file already there is checked at the first real run (O-161).
//
// The runner mints each token with its App's key (flows/lib/compose.ts, O-125); a refused token
// throws for a read and is answered as refused for the write. Tests pass fakes. Nothing here logs,
// and no token is kept.
import type {
  ProjectFile,
  ProjectFileCreate,
  ProjectSettings,
} from "../../core/new-project.ts";
import { projectFilePath } from "../../core/new-project.ts";
import {
  PROJECTS_BRANCH,
  PROJECTS_REPOSITORY,
  isProjectEntrySlug,
  parseProjectQuota,
  type ProjectQuota,
} from "../../core/project-entry.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";
import type { SettingsWriteTokens } from "./settings-write-tokens.ts";
import type { GitHubWriteHttp } from "./write-http.ts";

/** Foreman's own settings file on its main (D-436). */
export const FOREMAN_SETTINGS = {
  repository: "didi-build/foreman",
  path: "infra/kubernetes/settings/production.json",
  ref: "main",
} as const;

/** The largest contents answer the runner reads: GitHub serves base64 content up to 1 MiB. */
const MAX_CONTENTS_ANSWER_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS_ANSWER_BYTES = 1024 * 1024;
const MAX_WRITE_ANSWER_BYTES = 256 * 1024;
/** The largest project file the form writes; appendix A's file is about 400 bytes. */
export const MAX_PROJECT_FILE_BYTES = 16 * 1024;

const COMMIT = /^[0-9a-f]{40}$/;

export interface GitHubProjectSettingsOptions {
  /** The runner App's read-only tokens (D-267): `contents: read` for one repository. */
  readTokens: RunnerAppTokens;
  writeTokens: SettingsWriteTokens;
  http: GitHubHttp;
  write: GitHubWriteHttp;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function json(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** A file's text from GitHub's contents answer for `path`. Throws, naming the problem, on any other shape. */
export function fileTextOf(answer: unknown, path: string): string {
  if (
    !isObject(answer) ||
    answer.type !== "file" ||
    answer.path !== path ||
    answer.encoding !== "base64" ||
    typeof answer.content !== "string"
  ) {
    throw new GitHubReadError("the contents answer is not the file asked for");
  }
  return Buffer.from(answer.content, "base64").toString("utf8");
}

/** The standard quota from Foreman's settings file's text. Throws on any other shape. */
export function standardQuotaOf(text: string): ProjectQuota {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new GitHubReadError("Foreman's settings file is not JSON");
  }
  const quota = isObject(settings)
    ? parseProjectQuota(settings.projectStandardQuota)
    : null;
  if (quota === null) {
    throw new GitHubReadError("Foreman's settings file has no standard quota in full");
  }
  return quota;
}

export function createGitHubProjectSettings({
  readTokens,
  writeTokens,
  http,
  write,
}: GitHubProjectSettingsOptions): ProjectSettings {
  async function contents(
    token: string,
    repository: string,
    path: string,
    ref: string,
  ) {
    return http.get({
      path: `/repos/${repository}/contents/${path}?ref=${ref}`,
      token,
      accept: "json",
      maxBytes: MAX_CONTENTS_ANSWER_BYTES,
    });
  }

  return {
    async standardQuota() {
      const { repository, path, ref } = FOREMAN_SETTINGS;
      // Minted for this read only, with contents read on didi-build/foreman only (D-267).
      const token = await readTokens.mint({ repository, permission: "contents" });
      const answer = await contents(token, repository, path, ref);
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading Foreman's settings failed with ${answer.status}`,
        );
      }
      return standardQuotaOf(fileTextOf(json(answer.body), path));
    },

    async readFile(slug): Promise<ProjectFile | null> {
      if (!isProjectEntrySlug(slug)) throw new GitHubReadError("not a project slug");
      const path = projectFilePath(slug);
      // One token for this read's two calls, contents read on the settings repository only.
      const token = await readTokens.mint({
        repository: PROJECTS_REPOSITORY,
        permission: "contents",
      });
      const answer = await contents(token, PROJECTS_REPOSITORY, path, PROJECTS_BRANCH);
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading the project file failed with ${answer.status}`,
        );
      }
      const text = fileTextOf(json(answer.body), path);
      const commits = await http.get({
        path: `/repos/${PROJECTS_REPOSITORY}/commits?sha=${PROJECTS_BRANCH}&path=${path}&per_page=1`,
        token,
        accept: "json",
        maxBytes: MAX_COMMITS_ANSWER_BYTES,
      });
      if (commits.status !== 200) {
        throw new GitHubReadError(
          `reading the project file's commit failed with ${commits.status}`,
        );
      }
      const list = json(commits.body);
      const newest: unknown = Array.isArray(list) ? list[0] : undefined;
      const commit = isObject(newest) ? newest.sha : undefined;
      if (typeof commit !== "string" || !COMMIT.test(commit)) {
        throw new GitHubReadError("the project file's newest commit is not one");
      }
      return { text, commit };
    },

    async createFile({ slug, text, message }): Promise<ProjectFileCreate> {
      if (
        !isProjectEntrySlug(slug) ||
        typeof text !== "string" ||
        Buffer.byteLength(text, "utf8") > MAX_PROJECT_FILE_BYTES ||
        typeof message !== "string" ||
        message === "" ||
        /[\r\n]/.test(message)
      ) {
        return { kind: "refused", step: "call" };
      }
      const path = projectFilePath(slug);
      let token: string;
      try {
        // Minted for this one write, and never again with a wider request (D-443).
        token = await writeTokens.mint();
      } catch {
        return { kind: "refused", step: "token" };
      }
      let answer;
      try {
        answer = await write.send({
          method: "PUT",
          path: `/repos/${PROJECTS_REPOSITORY}/contents/${path}`,
          token,
          // No `sha`: GitHub then creates the file and never replaces one (appendix A).
          body: {
            message,
            content: Buffer.from(text, "utf8").toString("base64"),
            branch: PROJECTS_BRANCH,
          },
          maxBytes: MAX_WRITE_ANSWER_BYTES,
        });
      } catch {
        return { kind: "refused", step: "call" };
      }
      if (answer.status === 201) {
        const body = json(answer.body);
        const content = isObject(body) ? body.content : undefined;
        const commit =
          isObject(body) && isObject(body.commit) ? body.commit.sha : undefined;
        if (
          isObject(content) &&
          content.path === path &&
          typeof commit === "string" &&
          COMMIT.test(commit)
        ) {
          return { kind: "created", commit };
        }
        // Created, but the answer does not show it: the form reads the file to tell.
        return { kind: "not_created" };
      }
      if (answer.status === 409 || answer.status === 422)
        return { kind: "not_created" };
      return { kind: "refused", step: "call", status: answer.status };
    },
  };
}
