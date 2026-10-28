const WORKER_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * @param {string} slug
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function validateWorkerSlug(slug) {
  if (!slug) {
    return { ok: false, message: "Project slug is required." };
  }
  if (slug.length > 63) {
    return {
      ok: false,
      message:
        "Project slug must be at most 63 characters (Cloudflare Worker name limit).",
    };
  }
  if (!WORKER_SLUG_RE.test(slug)) {
    return {
      ok: false,
      message:
        "Project slug must use lowercase letters, digits, and dashes only, and cannot start or end with a dash.",
    };
  }
  return { ok: true };
}
