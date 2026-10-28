import {
  checkAttribution,
  LAUNCHPAD_LICENSE_PATH,
} from "./lib/launchpad-attribution.mjs";

const { failed, warnings, skipped } = checkAttribution(".");

if (skipped) {
  process.exit(0);
}

for (const line of warnings) {
  console.warn(line);
}

if (failed) {
  console.error(`Missing required file: ${LAUNCHPAD_LICENSE_PATH}`);
  process.exit(1);
}

process.exit(0);
