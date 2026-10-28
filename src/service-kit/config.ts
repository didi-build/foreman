// Configuration comes only from environment variables (ADR 0111). Errors name the setting,
// never its value, because a misplaced secret must not reach the logs.

export interface Setting<T> {
  /** Environment variable name. */
  env: string;
  /** Turn the raw value into T, or throw an Error whose message describes the problem without the value. */
  parse: (raw: string) => T;
  /** Used when the variable is unset. Omit to make the setting required. */
  fallback?: string;
}

export type ConfigOf<S extends Record<string, Setting<unknown>>> = {
  [K in keyof S]: S[K] extends Setting<infer T> ? T : never;
};

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function text(env: string, fallback?: string): Setting<string> {
  return {
    env,
    fallback,
    parse: (raw) => {
      if (raw.trim() === "") throw new Error("is empty");
      return raw;
    },
  };
}

export function port(env: string, fallback?: string): Setting<number> {
  return {
    env,
    fallback,
    parse: (raw) => {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error("is not a port number between 1 and 65535");
      }
      return value;
    },
  };
}

/** Read every setting, collecting all problems before failing, so one start shows every fix needed. */
export function readConfig<S extends Record<string, Setting<unknown>>>(
  settings: S,
  env: NodeJS.ProcessEnv = process.env,
): ConfigOf<S> {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, setting] of Object.entries(settings)) {
    const raw = env[setting.env] ?? setting.fallback;
    if (raw === undefined) {
      problems.push(`${setting.env} is not set`);
      continue;
    }
    try {
      values[key] = setting.parse(raw);
    } catch (error) {
      problems.push(
        `${setting.env} ${error instanceof Error ? error.message : "is invalid"}`,
      );
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return values as ConfigOf<S>;
}
