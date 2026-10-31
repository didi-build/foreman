// The Claude Code image's entrypoint (Developer, Designer). A job, not a service: no PORT, no
// /health. It prints one result line and exits 0 only on success (ADR 0106 section 4).
import { runClaudeCodeImage } from "./image.ts";

process.exitCode = await runClaudeCodeImage(process.env);
