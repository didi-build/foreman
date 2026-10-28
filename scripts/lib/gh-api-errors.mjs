/** @param {string} stderr */
export function parseGhHttpStatus(stderr) {
  const match = stderr?.match(/\(HTTP (\d{3})\)/);
  return match ? Number(match[1]) : null;
}

/** @param {number | null} httpStatus @param {string} stderr */
export function branchProtectionReadFailureReason(httpStatus, stderr) {
  if (httpStatus === 404) {
    return "no branch protection configured (HTTP 404)";
  }
  if (httpStatus === 403) {
    return "could not read branch protection (HTTP 403 — auth, plan, or token scope)";
  }
  if (httpStatus) {
    return `could not read branch protection (HTTP ${httpStatus}: ${stderr})`;
  }
  return `could not read branch protection (${stderr || "unknown error"})`;
}
