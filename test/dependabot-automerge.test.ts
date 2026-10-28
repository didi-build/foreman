import { describe, expect, it } from "vitest";
import {
  evaluatePrJson,
  isCleanStatusError,
  isDependabotAuthor,
  isEligible,
  pickPrNumber,
} from "../scripts/dependabot-automerge.mjs";

const ghPrViewFixture =
  '{"author":{"is_bot":true,"login":"app/dependabot"},"headRefName":"dependabot/github_actions/actions-minor-938e3d9051","labels":[{"id":"LA_kwDOU1nnQ88AAAAC8OVXtQ","name":"dependencies","description":"Pull requests that update a dependency file","color":"0366d6"},{"id":"LA_kwDOU1nnQ88AAAAC8OVX3g","name":"github_actions","description":"Pull requests that update GitHub Actions code","color":"000000"},{"id":"LA_kwDOU1nnQ88AAAAC8PA9Ow","name":"launchpad-dependabot-automerge","description":"Dependabot minor/patch PR eligible for auto-merge when CI is green","color":"1D76DB"}]}';

describe("dependabot-automerge (unit)", () => {
  describe("pickPrNumber", () => {
    it("proceeds when exactly one PR number is present", () => {
      expect(pickPrNumber("42")).toEqual({ ok: true, number: 42 });
      expect(pickPrNumber("  7  ")).toEqual({ ok: true, number: 7 });
      expect(pickPrNumber(["99"])).toEqual({ ok: true, number: 99 });
    });

    it("skips when zero or multiple PR numbers are present", () => {
      expect(pickPrNumber("")).toMatchObject({ ok: false });
      expect(pickPrNumber("   ")).toMatchObject({ ok: false });
      expect(pickPrNumber(undefined)).toMatchObject({ ok: false });
      expect(pickPrNumber("1 2")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("got 2"),
      });
    });

    it("skips invalid PR numbers", () => {
      expect(pickPrNumber("0")).toMatchObject({ ok: false });
      expect(pickPrNumber("abc")).toMatchObject({ ok: false });
    });
  });

  describe("isCleanStatusError", () => {
    it("detects GitHub clean status merge errors", () => {
      expect(isCleanStatusError("gh: Pull request is in clean status (HTTP 422)")).toBe(
        true,
      );
      expect(isCleanStatusError("something about clean status")).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isCleanStatusError("HTTP 403")).toBe(false);
      expect(isCleanStatusError("")).toBe(false);
      expect(isCleanStatusError(undefined)).toBe(false);
    });
  });

  describe("isDependabotAuthor", () => {
    it("accepts known Dependabot logins from gh and webhooks", () => {
      expect(isDependabotAuthor({ login: "dependabot[bot]", is_bot: true })).toBe(true);
      expect(isDependabotAuthor({ login: "app/dependabot", is_bot: true })).toBe(true);
      expect(isDependabotAuthor({ login: "dependabot", is_bot: true })).toBe(true);
    });

    it("rejects other authors and plain dependabot without is_bot", () => {
      expect(isDependabotAuthor({ login: "octocat", is_bot: false })).toBe(false);
      expect(isDependabotAuthor({ login: "dependabot-fan", is_bot: true })).toBe(false);
      expect(isDependabotAuthor({ login: "app/someone-else", is_bot: true })).toBe(
        false,
      );
      expect(isDependabotAuthor({ login: "dependabot", is_bot: false })).toBe(false);
    });
  });

  describe("isEligible", () => {
    const base = {
      author: { login: "dependabot[bot]", is_bot: true },
      headRef: "dependabot/npm_and_yarn/foo-1.2.3",
      labels: ["launchpad-dependabot-automerge"],
    };

    it("accepts qualified Dependabot PRs", () => {
      expect(isEligible(base)).toEqual({ ok: true });
      expect(
        isEligible({
          ...base,
          author: { login: "app/dependabot", is_bot: true },
        }),
      ).toEqual({ ok: true });
    });

    it("rejects non-Dependabot authors", () => {
      const result = isEligible({
        ...base,
        author: { login: "octocat", is_bot: false },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("octocat");
      }
    });

    it("rejects non-dependabot branches", () => {
      const result = isEligible({ ...base, headRef: "feature/foo" });
      expect(result.ok).toBe(false);
    });

    it("rejects PRs without the automerge label", () => {
      const result = isEligible({ ...base, labels: ["dependencies"] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("launchpad-dependabot-automerge");
      }
    });
  });

  describe("evaluatePrJson", () => {
    it("accepts real gh pr view JSON for a qualified Dependabot PR", () => {
      expect(evaluatePrJson(ghPrViewFixture)).toEqual({ ok: true });
    });

    it("rejects the same PR without the automerge label", () => {
      const pr = JSON.parse(ghPrViewFixture) as {
        labels: { name: string }[];
      };
      pr.labels = pr.labels.filter((l) => l.name !== "launchpad-dependabot-automerge");
      const result = evaluatePrJson(JSON.stringify(pr));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("launchpad-dependabot-automerge");
      }
    });

    it("rejects non-Dependabot authors from gh-shaped JSON", () => {
      const pr = JSON.parse(ghPrViewFixture) as {
        author: { login: string; is_bot: boolean };
      };
      pr.author = { login: "octocat", is_bot: false };
      expect(evaluatePrJson(JSON.stringify(pr)).ok).toBe(false);

      pr.author = { login: "dependabot", is_bot: false };
      expect(evaluatePrJson(JSON.stringify(pr)).ok).toBe(false);
    });

    it("rejects non-dependabot head branches", () => {
      const pr = JSON.parse(ghPrViewFixture) as { headRefName: string };
      pr.headRefName = "feature/x";
      expect(evaluatePrJson(JSON.stringify(pr)).ok).toBe(false);
    });
  });
});
