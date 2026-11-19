// The weekly model test flow (ADR 0117, D-427 to D-433, O-156). Once a day on the schedule in
// flows/windmill.yaml, or started by hand from its Windmill page, it reads the weekly test's Job
// that has not ended yet and stores its results, then starts this week's Job when the week has
// none (./lib/model-eval.ts). The first fire of each week (weeks start on Sunday, UTC) starts it;
// the next day's fire reads its result, so no Windmill run waits on the Job (D-369). Under the
// kill switch or in dry run it starts nothing, and while the test job's image is not pinned it
// refuses with a fixed reason. Its result names Jobs, weeks, models, counts and amounts, never a
// key or a model's text.
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { weeklyModelTest, type WeeklyModelTestResult } from "./lib/model-eval.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export async function run(deps: FlowDeps): Promise<WeeklyModelTestResult> {
  return weeklyModelTest(deps);
}

export async function main(): Promise<WeeklyModelTestResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps));
}
