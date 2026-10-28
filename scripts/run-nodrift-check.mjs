import { spawnSync } from "node:child_process";
import {
  formatNodriftMissingError,
  resolveNodriftCli,
  shouldRunNodriftCheck,
} from "./lib/resolve-nodrift-cli.mjs";

if (!shouldRunNodriftCheck(process.cwd())) {
  console.log(
    "nodrift check skipped (no .nodrift/manifest.json or docs/privacy/data-map.yml)",
  );
  process.exit(0);
}

const resolved = resolveNodriftCli(process.cwd());
if (!resolved.ok) {
  console.error(formatNodriftMissingError({ context: "check" }));
  process.exit(1);
}

const result = spawnSync(process.execPath, [resolved.cliPath, "check"], {
  encoding: "utf8",
  stdio: ["ignore", "inherit", "inherit"],
});

if (result.error) {
  console.error(`nodrift check failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status === 0 ? 0 : (result.status ?? 1));
