// The repo map Job's entrypoint (D-275 (2), O-87). A job, not a service: no PORT, no /health. It
// prints one result line and exits 0 only on success (ADR 0106 section 4).
import { runRepoMapImage } from "./image.ts";

process.exitCode = await runRepoMapImage(process.env);
