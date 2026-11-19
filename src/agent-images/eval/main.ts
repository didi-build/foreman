// The weekly test job's entrypoint (ADR 0117, D-432). A job, not a service: no PORT, no /health.
// It prints one result line and exits 0 only when it ran its plan (ADR 0106 section 4).
import { runEvalImage } from "./image.ts";

process.exitCode = await runEvalImage(process.env);
