// The GitHub adapter (ADR 0113 section 7): what ingestion and the runner need. The read calls
// implement the core's GitHubReader, the merge calls its GitHubMerger (build plan M3.3) and the
// deployment read its GitHubDeploymentReader (M3.4); webhook signature checking sits here because
// it holds the secret.
import type {
  GitHubDeploymentReader,
  GitHubMerger,
  GitHubReader,
} from "../../core/github.ts";

export interface GitHubAdapter
  extends GitHubReader, GitHubMerger, GitHubDeploymentReader {
  /**
   * True only when `signatureHeader` (`X-Hub-Signature-256`) is the HMAC-SHA256 of the raw body
   * under the webhook secret. Call it before parsing anything.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}
