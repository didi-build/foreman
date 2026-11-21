// A fake of the short-lived secret variable behind the Set project secret form's password field
// (ADR 0118 appendix D, O-163), for tests: what this run's record holds for the value argument and
// what the delete answers, as the test sets them. It keeps each call, in order. It never sees the
// value. No network and no Windmill.
import type {
  ShortLivedVariableFind,
  ShortLivedVariableRemoval,
  ShortLivedVariables,
} from "../../core/set-project-secret.ts";

/** A made-up short-lived variable's path, in the shape a password field makes. */
export const FAKE_SECRET_ARG_PATH = "u/test_only_user/secret_arg/TestOnly0123456789";

export interface FakeShortLivedVariables extends ShortLivedVariables {
  /** What `find` answers: the variable at `FAKE_SECRET_ARG_PATH` until the test sets another. */
  found: ShortLivedVariableFind | "throw";
  /** What `remove` answers: removed until the test sets another. */
  removal: ShortLivedVariableRemoval | "throw";
  /** Each call, in order: `find <argument>` or `remove <path>`. */
  readonly calls: string[];
}

export function createFakeShortLivedVariables(): FakeShortLivedVariables {
  const fake: FakeShortLivedVariables = {
    found: { kind: "variable", path: FAKE_SECRET_ARG_PATH },
    removal: { removed: true },
    calls: [],
    async find(argument) {
      fake.calls.push(`find ${argument}`);
      if (fake.found === "throw") throw new Error("the fake Windmill broke");
      return fake.found;
    },
    async remove(path) {
      fake.calls.push(`remove ${path}`);
      if (fake.removal === "throw") throw new Error("the fake Windmill broke");
      return fake.removal;
    },
  };
  return fake;
}
