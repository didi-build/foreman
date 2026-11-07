// Seam: the project repository port (unit with fakes, D-345, D-346, D-348, O-109). Fake token
// ports and fake HTTP ports stand in for the runner App and GitHub; the answers are synthetic JSON
// made here. The exact create request from the template, its answers (created, not created on a
// 422, refused), the fail-closed creation token, and the read of an existing repository with the
// read-only `contents` token. No network, no real repository or token.
import { describe, expect, it } from "vitest";

import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import { createGitHubProjectRepositories } from "./project-repositories.ts";
import type { RepositoryCreationTokens } from "./repository-creation-tokens.ts";
import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";

const SLUG = "garden-notes";
const DESCRIPTION = "A small notes app for the garden club.";
const CREATION_TOKEN = "fake-creation-token-not-real";
const READ_TOKEN = "fake-read-token-not-real";

/** A repository answer as GitHub documents it, trimmed to what the form reads. */
const repositoryAnswer = (extra: Record<string, unknown> = {}) => ({
  full_name: `didi-build/${SLUG}`,
  private: false,
  visibility: "public",
  template_repository: { full_name: "didi-build/launchpad" },
  ...extra,
});

function fakes(
  options: {
    postStatus?: number;
    postBody?: unknown;
    postThrows?: boolean;
    mintThrows?: boolean;
    getStatus?: number;
    getBody?: unknown;
  } = {},
) {
  const posts: GitHubPostRequest[] = [];
  const gets: GitHubGetRequest[] = [];
  const readMints: RunnerAppTokenRequest[] = [];
  let creationMints = 0;
  const encode = (body: unknown) =>
    new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const creationTokens: RepositoryCreationTokens = {
    async mint() {
      creationMints += 1;
      if (options.mintThrows)
        throw new Error("GitHub refused the repository creation token");
      return CREATION_TOKEN;
    },
  };
  const readTokens: RunnerAppTokens = {
    async mint(request) {
      readMints.push(request);
      return READ_TOKEN;
    },
  };
  const post: GitHubPostHttp = {
    async post(request) {
      posts.push(structuredClone(request));
      if (options.postThrows) throw new Error("the connection dropped");
      return {
        status: options.postStatus ?? 201,
        body: encode(options.postBody ?? repositoryAnswer()),
      };
    },
  };
  const http: GitHubHttp = {
    async get(request) {
      gets.push(request);
      return {
        status: options.getStatus ?? 200,
        body: encode(options.getBody ?? repositoryAnswer()),
      };
    },
  };
  const repositories = createGitHubProjectRepositories({
    creationTokens,
    readTokens,
    http,
    post,
  });
  return { repositories, posts, gets, readMints, creationMints: () => creationMints };
}

describe("creating a project repository from Launchpad (unit with fakes, D-345, D-348)", () => {
  it("sends exactly the template create, public, with the creation token", async () => {
    const f = fakes();
    expect(
      await f.repositories.generate({ name: SLUG, description: DESCRIPTION }),
    ).toEqual({
      kind: "created",
      repository: {
        fullName: `didi-build/${SLUG}`,
        private: false,
        visibility: "public",
        templateFullName: "didi-build/launchpad",
      },
    });
    expect(f.posts).toEqual([
      {
        path: "/repos/didi-build/launchpad/generate",
        token: CREATION_TOKEN,
        body: {
          owner: "didi-build",
          name: SLUG,
          description: DESCRIPTION,
          include_all_branches: false,
          private: false,
        },
        maxBytes: 1024 * 1024,
      },
    ]);
    expect(Object.keys(f.posts[0]?.body ?? {}).sort()).toEqual([
      "description",
      "include_all_branches",
      "name",
      "owner",
      "private",
    ]);
    expect(f.creationMints()).toBe(1);
    // The read token is never minted for the create, and the creation token never for a read.
    expect(f.readMints).toEqual([]);
    expect(f.gets).toEqual([]);
  });

  it("answers a created repository whose answer cannot be read with no facts", async () => {
    const f = fakes({ postBody: "not json" });
    expect(
      await f.repositories.generate({ name: SLUG, description: DESCRIPTION }),
    ).toEqual({
      kind: "created",
      repository: null,
    });
  });

  it("answers a 422 as not created, so the form reads what is there", async () => {
    const f = fakes({ postStatus: 422, postBody: { message: "name already exists" } });
    expect(
      await f.repositories.generate({ name: SLUG, description: DESCRIPTION }),
    ).toEqual({
      kind: "not_created",
    });
    expect(f.posts).toHaveLength(1);
  });

  it("answers any other status, or a failed request, as refused, after one attempt", async () => {
    for (const postStatus of [400, 401, 403, 404, 500]) {
      const f = fakes({ postStatus });
      expect(
        await f.repositories.generate({ name: SLUG, description: DESCRIPTION }),
        String(postStatus),
      ).toEqual({ kind: "refused", step: "create" });
      expect(f.posts).toHaveLength(1);
      expect(f.creationMints()).toBe(1);
    }
    const dropped = fakes({ postThrows: true });
    expect(
      await dropped.repositories.generate({ name: SLUG, description: DESCRIPTION }),
    ).toEqual({ kind: "refused", step: "create" });
  });

  it("fails closed on the creation token: no create, no other token, no second mint", async () => {
    const f = fakes({ mintThrows: true });
    expect(
      await f.repositories.generate({ name: SLUG, description: DESCRIPTION }),
    ).toEqual({
      kind: "refused",
      step: "creation_token",
    });
    expect(f.creationMints()).toBe(1);
    expect(f.posts).toEqual([]);
    expect(f.readMints).toEqual([]);
    expect(f.gets).toEqual([]);
  });

  it("refuses a name outside the slug rule before minting anything", async () => {
    const f = fakes();
    for (const name of ["Garden", "../foreman", "a/b", ""]) {
      expect(await f.repositories.generate({ name, description: DESCRIPTION })).toEqual(
        {
          kind: "refused",
          step: "create",
        },
      );
    }
    expect(f.creationMints()).toBe(0);
    expect(f.posts).toEqual([]);
  });
});

describe("reading an existing project repository (unit with fakes, D-345, O-109)", () => {
  it("reads it with a contents read token for that one repository", async () => {
    const f = fakes();
    expect(await f.repositories.read(SLUG)).toEqual({
      fullName: `didi-build/${SLUG}`,
      private: false,
      visibility: "public",
      templateFullName: "didi-build/launchpad",
    });
    expect(f.readMints).toEqual([
      { repository: `didi-build/${SLUG}`, permission: "contents" },
    ]);
    expect(f.gets).toEqual([
      {
        path: `/repos/didi-build/${SLUG}`,
        token: READ_TOKEN,
        accept: "json",
        maxBytes: 1024 * 1024,
      },
    ]);
    expect(f.creationMints()).toBe(0);
  });

  it("gives no template for a repository not generated from one, and null when it is missing", async () => {
    const plain = fakes({ getBody: repositoryAnswer({ template_repository: null }) });
    expect((await plain.repositories.read(SLUG))?.templateFullName).toBeNull();
    const noVisibility = fakes({
      getBody: repositoryAnswer({ visibility: undefined }),
    });
    expect((await noVisibility.repositories.read(SLUG))?.visibility).toBeNull();
    expect(await fakes({ getStatus: 404 }).repositories.read(SLUG)).toBeNull();
  });

  it("throws on a failed read or an answer that is not a repository", async () => {
    await expect(fakes({ getStatus: 500 }).repositories.read(SLUG)).rejects.toThrow(
      /failed with 500/,
    );
    for (const getBody of [
      "not json",
      { full_name: 7 },
      repositoryAnswer({ private: "no" }),
    ]) {
      await expect(fakes({ getBody }).repositories.read(SLUG)).rejects.toThrow(
        /not one/,
      );
    }
    await expect(fakes().repositories.read("../foreman")).rejects.toThrow(/slug/);
  });
});
