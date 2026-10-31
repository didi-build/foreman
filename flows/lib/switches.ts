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
