// The OpenCode image's entrypoint (Developer, Designer; D-222). A job, not a service: no PORT, no
// /health. It prints one result line and exits 0 only on success (ADR 0106 section 4).
import { runOpenCodeImage } from "./image.ts";

process.exitCode = await runOpenCodeImage(process.env);
