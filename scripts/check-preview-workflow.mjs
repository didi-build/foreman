import { pathToFileURL } from "node:url";
import { auditPreviewRepository } from "./lib/preview-workflow-guard.mjs";

function runCli() {
  const root = process.cwd();
  const violations = auditPreviewRepository(root);
  if (violations.length === 0) {
    return;
  }
  console.error("preview-workflow guard failed:\n");
  for (const { file, messages } of violations) {
    for (const message of messages) {
      console.error(`  - ${file}: ${message}`);
    }
  }
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli();
}

export { auditPreviewRepository } from "./lib/preview-workflow-guard.mjs";
export {
  findProductionTokenReferencesInText,
  findWranglerInvocationViolations,
  findWranglerEnvSelectionViolations,
  findPullRequestWorkflowViolations,
  findPreviewConfigViolations,
  findPreviewD1BindingViolations,
  findPreviewEnvKeyViolations,
  findPreviewIsolationViolations,
  findSharedResourceIdViolations,
  collectWranglerResourceIds,
  collectD1IdSet,
  collectKvIdSet,
  workflowOnTriggersPullRequest,
  REGRESSION_PRE_PR_WRANGLER_PREVIEW_LINE,
  MSG_NO_SUBCOMMAND,
  MSG_PREVIEW_CLOUDFLARE_ENV,
  MSG_PREVIEW_CONFIG_ENV_KEY,
  MSG_PREVIEW_ENV_SELECTION,
  MSG_WORKFLOW_CLOUDFLARE_ENV_PREVIEW,
} from "./lib/preview-workflow-guard.mjs";

export {
  joinShellContinuationLines,
  collectWranglerConfigPaths,
  validateWranglerConfigPaths,
  normalizeWranglerConfigPath,
} from "./lib/wrangler-config-path.mjs";
