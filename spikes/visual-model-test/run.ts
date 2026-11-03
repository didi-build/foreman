// Runs the visual comparison model test (./harness.ts) and prints one JSON record.
//
//   node spikes/visual-model-test/run.ts                      # the fake pixel oracle, no network
//   VISUAL_TEST_API_KEY=... node spikes/visual-model-test/run.ts --real --model <id>
//   VISUAL_TEST_API_KEY=... VISUAL_TEST_BASE_URL=https://api.deepinfra.com/v1/openai \
//     node spikes/visual-model-test/run.ts --real --api openai --model <id>
//
// A real run is Didi's credential gate (docs/costs.md section 7). The key is never printed.
import { isEntryPoint, redact } from "../lib/spike.ts";
import { runModelTest, selectModel } from "./harness.ts";

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
): Promise<number> {
  const choice = selectModel(argv, env);
  if ("refused" in choice) {
    write(JSON.stringify({ refused: choice.refused }));
    return choice.exitCode;
  }
  const record = await runModelTest(choice.model);
  write(
    redact(JSON.stringify({ real: choice.real, ...record }, null, 2), choice.secrets),
  );
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env, (line) =>
    console.log(line),
  );
}
