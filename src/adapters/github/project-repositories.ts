// The runner's port for project repositories (src/core/register-project.ts `ProjectRepositories`,
// D-345, D-346, D-348, O-109), used only by Didi's register-project form.
//
// `generate` mints the repository creation token (./repository-creation-tokens.ts) for this one
// call and sends GitHub's "Create a repository using a template",
// `POST /repos/didi-build/launchpad/generate`, with the organization as owner, the slug as name, the
// description, `private: false` (every project repository is public, D-348; the port has no
// visibility field) and `include_all_branches: false`. A refused mint or a failed or refused
// create is answered as refused, naming the step, and nothing is tried again. A 422, which GitHub
// gives when the name is taken, is answered as not created, so the form can read what is there.
//
// `read` reads `GET /repos/didi-build/<name>` with the runner App's read-only `contents` token for
// that one repository (D-267), the token the visibility check already uses: the creation token is
// never used for anything but the create.
//
// Until the runner App is registered (D-178) both token ports refuse with `NotBuiltError`
// (flows/lib/compose.ts). Tests pass fakes. Nothing here logs.
import {
  PROJECT_OWNER,
  PROJECT_SLUG,
  PROJECT_TEMPLATE,
  projectRepository,
  type ProjectRepositories,
  type RepositoryFacts,
  type TemplateGenerate,
} from "../../core/register-project.ts";
import type { GitHubPostHttp } from "./post-http.ts";
import type { RepositoryCreationTokens } from "./repository-creation-tokens.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** The largest repository answer the runner reads. */
const MAX_REPOSITORY_BYTES = 1024 * 1024;

export interface GitHubProjectRepositoriesOptions {
  creationTokens: RepositoryCreationTokens;
  readTokens: RunnerAppTokens;
  http: GitHubHttp;
  post: GitHubPostHttp;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The facts the form checks, from a repository answer; null when the answer is not one. */
export function repositoryFacts(body: Uint8Array): RepositoryFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const { full_name, private: isPrivate, visibility, template_repository } = parsed;
  if (typeof full_name !== "string" || typeof isPrivate !== "boolean") return null;
  if (visibility !== undefined && typeof visibility !== "string") return null;
  const template =
    isObject(template_repository) && typeof template_repository.full_name === "string"
      ? template_repository.full_name
      : null;
  return {
    fullName: full_name,
    private: isPrivate,
    visibility: visibility ?? null,
    templateFullName: template,
  };
}

export function createGitHubProjectRepositories({
  creationTokens,
  readTokens,
  http,
  post,
}: GitHubProjectRepositoriesOptions): ProjectRepositories {
  return {
    async generate({ name, description }): Promise<TemplateGenerate> {
      if (!PROJECT_SLUG.test(name)) return { kind: "refused", step: "create" };
      let token: string;
      try {
        // Minted for this one create, and never again with a wider request (D-346).
        token = await creationTokens.mint();
      } catch {
        return { kind: "refused", step: "creation_token" };
      }
      let answer;
      try {
        answer = await post.post({
          path: `/repos/${PROJECT_TEMPLATE}/generate`,
          token,
          body: {
            owner: PROJECT_OWNER,
            name,
            description,
            include_all_branches: false,
            private: false,
          },
          maxBytes: MAX_REPOSITORY_BYTES,
        });
      } catch {
        return { kind: "refused", step: "create" };
      }
      if (answer.status === 201) {
        return { kind: "created", repository: repositoryFacts(answer.body) };
      }
      if (answer.status === 422) return { kind: "not_created" };
      return { kind: "refused", step: "create" };
    },

    async read(name) {
      if (!PROJECT_SLUG.test(name)) throw new GitHubReadError("not a project slug");
      const repository = projectRepository(name);
      const token = await readTokens.mint({ repository, permission: "contents" });
      const answer = await http.get({
        path: `/repos/${repository}`,
        token,
        accept: "json",
        maxBytes: MAX_REPOSITORY_BYTES,
      });
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading the repository failed with ${answer.status}`,
        );
      }
      const facts = repositoryFacts(answer.body);
      if (!facts) throw new GitHubReadError("the repository answer is not one");
      return facts;
    },
  };
}
