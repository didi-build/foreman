// The Windmill binding of a flow's environment. It refuses until the Windmill workspace and the
// runner's Windmill token exist (first-hosting runbook, the Windmill step), the same way the
// GitHub client refused before its App was registered. Reading variables and the execution count
// from Windmill is written and checked then, against Windmill's own client and API; nothing here
// guesses at them. Two parts are fixed already. Every secret is a Windmill secret variable, which
// Windmill encrypts with the workspace's key, and every plain value a plain variable, each at
// `f/foreman/` followed by its path or name; none is a resource (D-370, O-120). And the runner's
// cluster token (a secret variable), endpoint and CA certificate (plain variables) are written by
// the Platform workflow (D-352, O-110), at the `windmill_path` flows/windmill.yaml gives, and the
// binding reads them there. Never used in tests.
import type { FlowEnvironment } from "./environment.ts";

export class WindmillNotConfiguredError extends Error {
  constructor(what: string) {
    super(`Windmill is not configured yet, so ${what} cannot be read (first hosting)`);
    this.name = "WindmillNotConfiguredError";
  }
}

export function windmillEnvironment(): FlowEnvironment {
  const refuse = (what: string) => async (): Promise<never> => {
    throw new WindmillNotConfiguredError(what);
  };
  return {
    secret: refuse("a secret variable"),
    value: refuse("a plain variable"),
    executionsThisMonth: refuse("the execution count"),
  };
}
