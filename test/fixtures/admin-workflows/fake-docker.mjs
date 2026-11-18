// A stand-in for docker in test/admin-workflow-scripts.test.ts. It appends every call to the JSON
// lines file FAKE_LOG and answers `buildx imagetools inspect <ref>` with a digest made from the
// reference, as the registry would give one per pushed image. Builds and pushes do nothing, except
// that FAKE_DOCKER_PUSH_FAILS (`<ref>=<n>`) makes the first n pushes of that reference fail as the
// registry's "unknown blob" did.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args })}\n`);
const fails = process.env.FAKE_DOCKER_PUSH_FAILS;
if (args[0] === "push" && fails) {
  const at = fails.lastIndexOf("=");
  const [ref, times] = [fails.slice(0, at), Number(fails.slice(at + 1))];
  if (args[1] === ref) {
    const pushes = readFileSync(process.env.FAKE_LOG, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line).args)
      .filter((a) => a[0] === "push" && a[1] === ref).length;
    if (pushes <= times) {
      process.stderr.write("unknown blob\n");
      process.exit(1);
    }
  }
}
if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
  const digest = createHash("sha256").update(args[3]).digest("hex");
  process.stdout.write(`${JSON.stringify({ digest: `sha256:${digest}` })}\n`);
}
