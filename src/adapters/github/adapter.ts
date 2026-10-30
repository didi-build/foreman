// The GitHub adapter (ADR 0113 section 7): only what ingestion needs. The read calls implement
// the core's GitHubReader; webhook signature checking sits here because it holds the secret.
import type { GitHubReader } from "../../core/github.ts";

export interface GitHubAdapter extends GitHubReader {
  /**
   * True only when `signatureHeader` (`X-Hub-Signature-256`) is the HMAC-SHA256 of the raw body
   * under the webhook secret. Call it before parsing anything.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}
