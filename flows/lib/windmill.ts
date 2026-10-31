// The Windmill binding of a flow's environment. It refuses until the Windmill workspace and the
// runner's Windmill token exist (first-hosting runbook, the Windmill step), the same way the
// GitHub client refused before its App was registered. Reading resources, variables and the
// execution count from Windmill is written and checked then, against Windmill's own client and
// API; nothing here guesses at them. Never used in tests.
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
    secret: refuse("a resource"),
    value: refuse("a variable"),
    executionsThisMonth: refuse("the execution count"),
  };
}
