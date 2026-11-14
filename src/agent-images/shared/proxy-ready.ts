// Waiting for the run's egress proxy before the agent's first request (O-133). The runtime creates
// the proxy's Job and Service and then, at once, the agent's Job
// (src/adapters/agent-runtime/kubernetes/runtime.ts), so the agent's pod can start before the
// proxy answers. The model client makes no retry of its own (`maxRetries: 0`, so no retry spends
// the proxy's request ceiling), and a refused connection ended the rehearsal's first Triage runs
// at once with "the model endpoint could not be reached". Each agent image therefore waits for
// the proxy's `GET /health`, the readiness check the proxy's pod has, before anything else; the
// two job images retry each request instead (./job-kit.ts). The health check carries no
// credential and counts against no ceiling. Nothing here logs.

/** The longest the agent waits for its proxy. */
export const PROXY_READY_TIMEOUT_MS = 60_000;
/** The wait between two checks. */
export const PROXY_READY_POLL_MS = 1_000;
/** One check's own bound. */
const CHECK_TIMEOUT_MS = 2_000;
/** The run's error when the proxy never answered: one of the fixed sentences D-385 keeps. */
export const PROXY_NOT_READY = "the run's egress proxy did not become ready";

export interface ProxyReadyDeps {
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The proxy's origin, from a URL the image already reads that points at it. */
export function proxyOrigin(urlOnProxy: string): string {
  return new URL(urlOnProxy).origin;
}

/**
 * Returns once `GET <proxy>/health` answers 200, checking every `PROXY_READY_POLL_MS`; throws
 * `PROXY_NOT_READY` after `PROXY_READY_TIMEOUT_MS`. A refused connection, a timeout or any other
 * answer counts as not ready yet.
 */
export async function waitForProxy(
  urlOnProxy: string,
  deps: ProxyReadyDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const wait = deps.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const health = `${proxyOrigin(urlOnProxy)}/health`;
  const deadline = now() + PROXY_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetchImpl(health, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // Not listening yet, or no answer in time: check again.
    }
    if (now() >= deadline) throw new Error(PROXY_NOT_READY);
    await wait(PROXY_READY_POLL_MS);
  }
}
