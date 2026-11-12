// The Scanner's stage 1 flow (D-150, D-299, D-300, O-92). Once a day on the schedule in
// flows/windmill.yaml, at 05:00 Toronto time so it ends before the 06:00 daily check (D-297), or
// started by hand from its Windmill page, it scans every project's repository with the fixed
// checks in the repo map Job's scan mode and files each new finding as an idea in that project,
// at most 5 per scan, duplicates merged, new findings folded into open scanner ideas in the same
// file, and ideas it no longer finds cleaned up (./lib/scan.ts, D-301). The daily check shows what
// the last scan found. Under the kill switch or in dry run it scans nothing, records nothing and
// says so in its result.
import { scanPass, type ScanPassResult } from "./lib/scan.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export async function run(deps: FlowDeps): Promise<ScanPassResult> {
  return scanPass(deps);
}

export async function main(): Promise<ScanPassResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps));
}
