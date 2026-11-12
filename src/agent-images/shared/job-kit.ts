// Small pieces the two job images that download from GitHub share: the repo map Job (D-275 (2),
// O-87) and QA's fetch step (O-124). A setting that must match a pattern, named and never
// repeated, and the retry of a request whose connection failed before GitHub answered: the
// Job's egress proxy may not be ready yet when its pod starts. An answer GitHub gave is never
// retried.
import type { Setting } from "../../service-kit/config.ts";

/** A setting that must match `pattern`; the problem names the setting, never its value. */
export const matching = (
  env: string,
  pattern: RegExp,
  problem: string,
): Setting<string> => ({
  env,
  parse: (raw) => {
    if (!pattern.test(raw)) throw new Error(problem);
    return raw;
  },
});

/** Tries of a request whose connection failed before any answer. */
export const CONNECT_TRIES = 5;
/** The wait between two tries. */
export const CONNECT_RETRY_MS = 3_000;

/**
 * Runs `request`, and again only when it failed before the server answered (`fetch`'s
 * TypeError), at most `CONNECT_TRIES` times in all.
 */
export async function retryConnects<T>(
  request: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= CONNECT_TRIES) throw error;
      await wait(CONNECT_RETRY_MS);
    }
  }
}
