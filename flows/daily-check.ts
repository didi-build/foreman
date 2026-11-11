// The daily check flow (build plan M4.4, spec section 6, O-91, D-319, D-320, O-100). Once a day on
// the schedule in flows/windmill.yaml, or started by hand from its Windmill page, it generates
// Didi's daily check from the store (src/core/daily-check.ts), with the last Scanner scan per
// project (O-92). Its run's result is the page Didi reads: Didi bookmarks this flow's run list in
// Windmill, signed in, and opens the latest run. The result uses Windmill's `render_all`: first
// the check as a page for reading on a phone (`html`, src/core/daily-check-render.ts), whose links
// are the staging addresses and each held item's fresh release request page (D-295), then the
// structured check and the same check as short plain text (`json`). It writes nothing and opens,
// re-asks or answers no request (D-272). It runs whatever the kill switch and dry run say, since
// reading is not acting, and the check says when either is on. Nothing here sends anything: no
// push alert and no email (D-319); a push alert linking to the page waits for the frontend.
import { type DailyCheck, generateDailyCheck } from "../src/core/daily-check.ts";
import {
  renderDailyCheck,
  renderDailyCheckHtml,
} from "../src/core/daily-check-render.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import {
  HOLD_RELEASE_REQUEST_FLOW_PATH,
  HOLD_RELEASE_REQUEST_PAGE,
} from "./lib/held-items.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

/** The check as data: what the page shows, for reading in Windmill's JSON view or by code. */
export interface DailyCheckData {
  check: DailyCheck;
  /** The same check as short plain text. */
  text: string;
}

/**
 * Windmill renders a result with only a `render_all` key as each view in turn: the page first,
 * then the data as JSON. The data is always at `render_all[1].json`.
 */
export interface DailyCheckFlowResult {
  render_all: [{ html: string }, { json: DailyCheckData }];
}

export async function run(deps: FlowDeps): Promise<DailyCheckFlowResult> {
  const check = await generateDailyCheck(deps, {
    holdReleaseRequestFlow: HOLD_RELEASE_REQUEST_FLOW_PATH,
  });
  const html = renderDailyCheckHtml(check, {
    flowPages: { [HOLD_RELEASE_REQUEST_FLOW_PATH]: HOLD_RELEASE_REQUEST_PAGE },
  });
  return {
    render_all: [{ html }, { json: { check, text: renderDailyCheck(check) } }],
  };
}

export async function main(): Promise<DailyCheckFlowResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps));
}
