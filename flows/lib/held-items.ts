// The held-items list as the reconcile flow's result carries it (D-272, O-90). The daily check's
// generator (src/core/daily-check.ts, flows/daily-check.ts, O-91) reads the same list and adds the
// same fresh-request entry through `withFreshRequest`. Each entry names the called flow that opens
// a fresh release request for that one item and the input to start it with: a Windmill path, not
// a URL. Didi starts that flow from its Windmill page, signed in (D-295); the daily check's
// delivery (M4.3, M4.4) links to the same page.
//
// The same result carries both kinds of stalled work (D-302, O-94) from the one read-only stall
// check the reconcile pass's step 5 and the daily check read (src/core/stalls.ts): active runs
// quiet past their budget, and items ready to start for a reconcile cycle with no run, each with
// what it waits on. Listed on every pass, whatever the switches; listing writes nothing.
import {
  listHeldItems,
  withFreshRequest,
  type HeldItemWithRequest,
} from "../../src/core/held-items.ts";
import {
  stalledItems,
  stalledRuns,
  type StalledItem,
  type StalledRun,
} from "../../src/core/stalls.ts";
import type { FlowDeps } from "./compose.ts";

/** The called flow that opens a fresh release request for one held item (flows/windmill.yaml). */
export const HOLD_RELEASE_REQUEST_FLOW_PATH = "f/foreman/hold_release_request";

/** A held item with how Didi asks for a fresh release request for it. Nothing starts it on its own. */
export type HeldItemEntry = HeldItemWithRequest<typeof HOLD_RELEASE_REQUEST_FLOW_PATH>;

/** Every held item with no open release request, with its fresh-request flow. Reads only. */
export async function heldItemsForDailyCheck(deps: FlowDeps): Promise<HeldItemEntry[]> {
  return withFreshRequest(await listHeldItems(deps), HOLD_RELEASE_REQUEST_FLOW_PATH);
}

/** The lists the reconcile flow's result carries for Didi's daily check, on every pass. */
export interface DailyCheck {
  /** Held items with no open release request (D-272), read only. */
  heldItems: HeldItemEntry[];
  /** Active runs with no activity past their budget (D-302), longest idle first, read only. */
  stalledRuns: StalledRun[];
  /** Items ready to start for a reconcile cycle with no run (D-112, D-302), longest first. */
  stalledItems: StalledItem[];
}

/** The daily check's lists. A problem reading them is added to `problems`. */
export async function dailyCheckLists(
  deps: FlowDeps,
  problems: string[] = [],
): Promise<DailyCheck> {
  const items = await stalledItems(deps);
  if (items.problem) problems.push(items.problem);
  return {
    heldItems: await heldItemsForDailyCheck(deps),
    stalledRuns: await stalledRuns(deps),
    stalledItems: items.items,
  };
}
