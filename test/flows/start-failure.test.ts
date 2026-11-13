// A failed start keeps its error's kind and, for Foreman's own errors, their fixed sentence
// (D-384, flows/lib/start-failure.ts). Unit: the summary function on errors built from the real
// classes, with made-up text only.
import { describe, expect, it } from "vitest";
import { NotBuiltError as ComposeNotBuiltError } from "../../flows/lib/compose.ts";
import {
  SAFE_MESSAGE_ERRORS,
  START_ERROR_MESSAGE_CHARS,
  startError,
  startFailed,
} from "../../flows/lib/start-failure.ts";
import {
  WindmillNotConfiguredError,
  WindmillReadError,
} from "../../flows/lib/windmill.ts";
import { KubernetesApiError } from "../../src/adapters/agent-runtime/kubernetes/client.ts";
import { RepoMapJobError } from "../../src/adapters/agent-runtime/kubernetes/repo-maps.ts";
import { GitHubAppJwtError } from "../../src/adapters/github/app-jwt.ts";
import { InstallationTokenError } from "../../src/adapters/github/installation-tokens.ts";
import { RunnerMergeTokenError } from "../../src/adapters/github/merge-tokens.ts";
import { GitHubReadError } from "../../src/adapters/github/runner-app-tokens.ts";
import { RunnerAppTokenError } from "../../src/adapters/github/runner-read-tokens.ts";
import { NotBuiltError as ClientNotBuiltError } from "../../src/adapters/windmill/client.ts";
import { RepoMapError } from "../../src/core/repo-map.ts";

describe("a failed start's error (unit: flows/lib/start-failure.ts, D-384)", () => {
  it("names each kept class exactly as the class names itself, so a rename is caught", () => {
    const own = [
      new KubernetesApiError("create Job in agents-example", 403, "Forbidden"),
      new RepoMapJobError("the repo map Job failed"),
      new RepoMapError("the repo map is not an object"),
      new GitHubReadError("reading the repository failed with 404"),
      new RunnerAppTokenError("a made-up refusal"),
      new InstallationTokenError("The runner App is not installed on the repository"),
      new GitHubAppJwtError("The runner App's id is not a positive whole number"),
      new RunnerMergeTokenError("a made-up refusal"),
      new WindmillReadError("Windmill did not answer the read of a made-up path"),
      new WindmillNotConfiguredError("a made-up setting is missing"),
      new ComposeNotBuiltError("a made-up part waits on Didi"),
      new ClientNotBuiltError("a made-up part waits on Didi"),
    ];
    expect([...new Set(own.map((e) => e.name))].sort()).toEqual(
      [...SAFE_MESSAGE_ERRORS].sort(),
    );
    for (const error of own) {
      expect(startError(error)).toEqual({ type: error.name, message: error.message });
    }
  });

  it("keeps a Kubernetes refusal's operation, status and reason", () => {
    expect(
      startFailed(
        new KubernetesApiError("create Job in agents-example", 403, "Forbidden"),
      ),
    ).toEqual({
      outcome: "start_failed",
      error: {
        type: "KubernetesApiError",
        message: "Kubernetes create Job in agents-example failed with 403 Forbidden",
      },
    });
  });

  it("keeps only the kind of any other error: its message could hold a value", () => {
    expect(startError(new Error("password=made-up-value"))).toEqual({ type: "Error" });
    expect(startError(new TypeError("fetch failed for a made-up host"))).toEqual({
      type: "TypeError",
    });
    class DatabaseError extends Error {
      constructor() {
        super('duplicate key value (made-up)=("made-up")');
        this.name = "DatabaseError";
      }
    }
    expect(startError(new DatabaseError())).toEqual({ type: "DatabaseError" });
  });

  it("names a thrown value that is not an Error by its type only", () => {
    expect(startError("a made-up thrown string")).toEqual({ type: "string" });
    expect(startError(undefined)).toEqual({ type: "undefined" });
    expect(startError({ token: "made-up" })).toEqual({ type: "object" });
  });

  it("calls an error with an odd name a plain Error, so its message is not kept", () => {
    const odd = new Error("a made-up message");
    odd.name = "Repo Map Job Error\n";
    expect(startError(odd)).toEqual({ type: "Error" });
  });

  it("puts a kept message on one line and cuts it short", () => {
    const long = new RepoMapJobError(
      `the repo map Job failed:\n${"word ".repeat(200)}`,
    );
    const kept = startError(long).message ?? "";
    expect(kept).not.toMatch(/[\n\r\t]/);
    expect(kept.startsWith("the repo map Job failed: word")).toBe(true);
    expect(kept.length).toBe(START_ERROR_MESSAGE_CHARS);
    expect(startError(new RepoMapJobError("\n\n"))).toEqual({
      type: "RepoMapJobError",
    });
  });
});
