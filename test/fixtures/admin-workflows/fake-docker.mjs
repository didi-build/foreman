// A stand-in for docker in test/admin-workflow-scripts.test.ts. It appends every call to the JSON
// lines file FAKE_LOG and answers `buildx imagetools inspect <ref>` with a digest made from the
// reference, as the registry would give one per pushed image. Builds and pushes do nothing.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args })}\n`);
if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
  const digest = createHash("sha256").update(args[3]).digest("hex");
  process.stdout.write(`${JSON.stringify({ digest: `sha256:${digest}` })}\n`);
}
