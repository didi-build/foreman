// The two settings every flow reads before it acts (architecture section 2.5, FR-15). Read the
// same way the library reads them: the kill switch is on only when set to true, and dry run is on
// unless set to false, so a missing setting never acts for real.
import type { StoreOps } from "../../src/core/store.ts";

export async function killSwitchOn(
  store: Pick<StoreOps, "getSetting">,
): Promise<boolean> {
  return (await store.getSetting("kill_switch"))?.value === true;
}

export async function dryRunOn(store: Pick<StoreOps, "getSetting">): Promise<boolean> {
  return (await store.getSetting("dry_run"))?.value !== false;
}

/** Which switch, if any, holds the runner from acting now: the kill switch first, then dry run. */
export async function heldBy(
  store: Pick<StoreOps, "getSetting">,
): Promise<"kill_switch" | "dry_run" | null> {
  if (await killSwitchOn(store)) return "kill_switch";
  return (await dryRunOn(store)) ? "dry_run" : null;
}
