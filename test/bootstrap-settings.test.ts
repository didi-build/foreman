// Unit and integration: the repository settings script, `.github/scripts/bootstrap-settings.mjs`
// (D-358 lock 1, O-113), which Bootstrap's token job runs with the token and `npm run
// repo-settings` runs by hand. GitHub is a fake: in process for the unit tests, and loaded into
// node with --import for the CLI. The token is made up.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GithubRequestError,
  applySettings,
  branchProtectionReadFailureReason,
  dependabotAutomergeLabel,
  targetBranchProtection,
  targetRepositorySettings,
  verifySettings,
} from "../.github/scripts/bootstrap-settings.mjs";
import {
  FAKE_TOKEN,
  fakeFetch,
  fakeGithubEnv,
  hermeticEnv,
  repoRoot,
  runScript,
  tempDir,
  type GithubAnswer,
} from "./bootstrap-fixture.ts";

const REPO = "didi-build/my-repo";
const LABEL = `GET /repos/${REPO}/labels/${dependabotAutomergeLabel}`;
const CREATE_LABEL = `POST /repos/${REPO}/labels`;
const PATCH_REPO = `PATCH /repos/${REPO}`;
const PUT_PROTECTION = `PUT /repos/${REPO}/branches/main/protection`;
const GET_PROTECTION = `GET /repos/${REPO}/branches/main/protection`;
const GET_REPO = `GET /repos/${REPO}`;

const appliedProtection = {
  required_status_checks: { strict: false, checks: [{ context: "check" }] },
  enforce_admins: { enabled: false },
  required_pull_request_reviews: { required_approving_review_count: 0 },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};
const github: Record<string, GithubAnswer> = {
  [LABEL]: { status: 404, body: { message: "Not Found" } },
  [CREATE_LABEL]: { status: 201, body: { name: dependabotAutomergeLabel } },
  [PATCH_REPO]: { status: 200, body: {} },
  [PUT_PROTECTION]: { status: 200, body: {} },
  [GET_PROTECTION]: { status: 200, body: appliedProtection },
  [GET_REPO]: { status: 200, body: { full_name: REPO, ...targetRepositorySettings() } },
};

const client = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  apiUrl: "https://api.github.com",
  token: FAKE_TOKEN,
});

describe("applySettings and verifySettings (unit: fake GitHub)", () => {
  it("creates the label, sets the merge settings, then protects the branch last", async () => {
    const { fetchImpl, requests } = fakeFetch(github);
    const lines: string[] = [];
    await applySettings(client(fetchImpl), REPO, "main", (line) => lines.push(line));
    expect(requests.map((r) => r.key)).toEqual([
      LABEL,
      CREATE_LABEL,
      PATCH_REPO,
      PUT_PROTECTION,
    ]);
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(request.redirect).toBe("error");
      expect(request.url.startsWith("https://api.github.com/")).toBe(true);
    }
    expect(JSON.parse(requests[1].body ?? "")).toEqual({
      name: dependabotAutomergeLabel,
      color: "1D76DB",
      description: "Dependabot minor/patch PR eligible for auto-merge when CI is green",
    });
    expect(JSON.parse(requests[2].body ?? "")).toEqual(targetRepositorySettings());
    expect(JSON.parse(requests[3].body ?? "")).toEqual(targetBranchProtection());
    expect(lines.join("\n")).toContain("Branch protection updated.");
  });

  it("leaves an existing label alone", async () => {
    const { fetchImpl, requests } = fakeFetch({
      ...github,
      [LABEL]: { status: 200, body: {} },
    });
    await applySettings(client(fetchImpl), REPO, "main", () => {});
    expect(requests.map((r) => r.key)).toEqual([LABEL, PATCH_REPO, PUT_PROTECTION]);
  });

  it("stops at the first refusal, so the branch is never protected after a failed step", async () => {
    const { fetchImpl, requests } = fakeFetch({
      ...github,
      [PATCH_REPO]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await applySettings(client(fetchImpl), REPO, "main", () => {}).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GithubRequestError);
    expect(String(error)).toContain(
      "PATCH /repos/didi-build/my-repo failed (HTTP 403): Resource not accessible by personal access token",
    );
    expect(String(error)).not.toContain(FAKE_TOKEN);
    expect(requests.map((r) => r.key)).not.toContain(PUT_PROTECTION);
  });

  it("verifies both, and names what does not match", async () => {
    expect(
      (await verifySettings(client(fakeFetch(github).fetchImpl), REPO, "main")).ok,
    ).toBe(true);

    const missing = await verifySettings(
      client(fakeFetch({ ...github, [GET_PROTECTION]: { status: 404 } }).fetchImpl),
      REPO,
      "main",
    );
    expect(missing.ok).toBe(false);
    expect(missing.lines.join("\n")).toContain(
      "no branch protection configured (HTTP 404)",
    );

    const merges = await verifySettings(
      client(
        fakeFetch({
          ...github,
          [GET_REPO]: {
            status: 200,
            body: { ...targetRepositorySettings(), allow_merge_commit: true },
          },
        }).fetchImpl,
      ),
      REPO,
      "main",
    );
    expect(merges.ok).toBe(false);
    expect(merges.lines.join("\n")).toContain("merge settings do not match");

    const extraCheck = await verifySettings(
      client(
        fakeFetch({
          ...github,
          [GET_PROTECTION]: {
            status: 200,
            body: {
              ...appliedProtection,
              required_status_checks: {
                strict: false,
                checks: [{ context: "check" }, { context: "QA" }],
              },
            },
          },
        }).fetchImpl,
      ),
      REPO,
      "main",
    );
    expect(extraCheck.ok).toBe(false);
  });

  it("names a refused protection read by its status only", () => {
    expect(branchProtectionReadFailureReason(404)).toContain("HTTP 404");
    expect(branchProtectionReadFailureReason(403)).toContain("HTTP 403");
    expect(branchProtectionReadFailureReason(0)).toContain("no answer");
    expect(branchProtectionReadFailureReason(500)).toContain("HTTP 500");
  });
});

function settings(args: string[], env: Record<string, string>, answers = github) {
  const dir = tempDir("bootstrap-settings-");
  const fake = fakeGithubEnv(dir, answers);
  const result = runScript("bootstrap-settings.mjs", args, {
    cwd: dir,
    env: hermeticEnv({ ...fake.env, GITHUB_REPOSITORY: REPO, ...env }),
  });
  return { ...result, requests: fake.requests() };
}

describe("bootstrap-settings.mjs (integration: node with a fake GitHub)", () => {
  it("applies then verifies with the token in GH_TOKEN, and never prints it", () => {
    const result = settings(["--apply", "--verify", "main"], { GH_TOKEN: FAKE_TOKEN });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((r) => r.key)).toEqual([
      LABEL,
      CREATE_LABEL,
      PATCH_REPO,
      PUT_PROTECTION,
      GET_PROTECTION,
      GET_REPO,
    ]);
    expect(result.stdout + result.stderr + result.summary).not.toContain(FAKE_TOKEN);
    expect(result.summary).toContain("Settings verify: passed.");
  });

  it("fails with GitHub's status when a write is refused, and prints no token", () => {
    const result = settings(
      ["--apply", "--verify"],
      { GH_TOKEN: FAKE_TOKEN },
      {
        ...github,
        [PUT_PROTECTION]: { status: 422, body: { message: "Validation Failed" } },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "PUT /repos/didi-build/my-repo/branches/main/protection failed (HTTP 422): Validation Failed",
    );
    expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
    expect(result.requests.map((r) => r.key)).not.toContain(GET_PROTECTION);
  });

  it("rejects a token with a newline or space inside, or an empty one, before any request", () => {
    for (const bad of ["ghp_inner\nnewline", "ghp inner", ""]) {
      const result = settings(["--apply", "--verify"], { GH_TOKEN: bad });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Malformed BOOTSTRAP_TOKEN");
      expect(result.requests).toHaveLength(0);
      expect(result.summary).toContain("malformed");
    }
  });

  it("warns on a token with spaces at its ends and sends the trimmed value", () => {
    const result = settings(["--apply"], { GH_TOKEN: `${FAKE_TOKEN}\n` });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=BOOTSTRAP_TOKEN trimmed");
    expect(result.requests[0].headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("refuses to run without GITHUB_REPOSITORY, or against a non-https API", () => {
    expect(settings([], { GITHUB_REPOSITORY: "" }).stderr).toContain(
      "Set GITHUB_REPOSITORY",
    );
    const plain = settings(["--verify"], {
      GH_TOKEN: FAKE_TOKEN,
      GITHUB_API_URL: "http://api.github.com",
    });
    expect(plain.status).toBe(1);
    expect(plain.requests).toHaveLength(0);
  });

  it("is what npm run repo-settings runs (the manual fallback)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["repo-settings"]).toBe(
      "node .github/scripts/bootstrap-settings.mjs",
    );
  });
});
