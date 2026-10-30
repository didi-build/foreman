// The Messages API image's entrypoint (QA, Council, Triage). A job, not a service: no PORT, no
// /health. It prints one result line and exits 0 only on success (ADR 0106 section 4).
import { runClaudeApiImage } from "./image.ts";

process.exitCode = await runClaudeApiImage(process.env);
