// The daily check flow (build plan M4.4, spec section 6, O-91). Once a day on the schedule in
// flows/windmill.yaml, or started by hand from its Windmill page, it generates Didi's daily check
// from the store (src/core/daily-check.ts) and returns it as structured JSON plus a short
// plain-text rendering, which Didi reads in the job's result in Windmill. It writes nothing and
// opens, re-asks or answers no request (D-272). It runs whatever the kill switch and dry run say,
// since reading is not acting, and the result says when either is on. Delivery (push, email, a
// page) waits for the notifications milestone (M4.3); nothing here sends anything.
import {
  generateDailyCheck,
  renderDailyCheck,
  type DailyCheck,
} from "../src/core/daily-check.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { HOLD_RELEASE_REQUEST_FLOW_PATH } from "./lib/held-items.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface DailyCheckFlowResult {
  check: DailyCheck;
  /** The same check as short plain text. */
  text: string;
}

export async function run(deps: FlowDeps): Promise<DailyCheckFlowResult> {
  const check = await generateDailyCheck(deps, {
    holdReleaseRequestFlow: HOLD_RELEASE_REQUEST_FLOW_PATH,
  });
  return { check, text: renderDailyCheck(check) };
}

export const main = (): Promise<DailyCheckFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps));
