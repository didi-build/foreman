// QA's fetch step's entrypoint (ADR 0106 section 5, O-124). A job, not a service: no PORT, no
// /health. It prints one result line and exits 0 only when the commit's tree is in the workspace.
import { runQaFetchImage } from "./image.ts";

process.exitCode = await runQaFetchImage(process.env);
