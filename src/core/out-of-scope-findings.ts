// The bugs a Developer, Designer or QA run noticed outside its item (D-244, O-65). They are not
// part of the item's work: the runner submits each as a new idea in Machine 1, and the Council
// sizes it (./finding-ideas.ts). The field is `outOfScopeFindings`, so it cannot be read as QA's
// blocking `findings` (file and line citations that fail the PR).
//
// This one check is shared: the OpenCode image reads the list from the `foreman-report` block,
// the Messages API image from QA's verdict, the state API's `POST /qa-verdicts` checks it again,
// and the runner once more before it creates ideas. It has no imports, so each image's Dockerfile
// copies this file alone. The check is strict: a list of at most 3 objects with exactly `title`
// (one line, 1 to 120 characters) and `detail` (1 to 1,000 characters), both trimmed. Left out,
// the list is empty. Nothing is guessed: any other shape is a problem the caller fails on.

export interface OutOfScopeFinding {
  /** One line, trimmed, 1 to `MAX_FINDING_TITLE` characters. */
  title: string;
  /** What was seen, trimmed, 1 to `MAX_FINDING_DETAIL` characters. */
  detail: string;
}

export const OUT_OF_SCOPE_FINDINGS = "outOfScopeFindings";
export const MAX_FINDINGS = 3;
export const MAX_FINDING_TITLE = 120;
export const MAX_FINDING_DETAIL = 1000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The list, trimmed, or the reason it is unusable. `undefined` is an empty list. */
export function readOutOfScopeFindings(
  value: unknown,
): { findings: OutOfScopeFinding[] } | { problem: string } {
  if (value === undefined) return { findings: [] };
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    return {
      problem: `${OUT_OF_SCOPE_FINDINGS} must be a list of at most ${MAX_FINDINGS} items`,
    };
  }
  const findings: OutOfScopeFinding[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.title !== "string" ||
      typeof item.detail !== "string"
    ) {
      return {
        problem: `each of ${OUT_OF_SCOPE_FINDINGS} must have title and detail only`,
      };
    }
    const title = item.title.trim();
    const detail = item.detail.trim();
    if (title === "" || title.length > MAX_FINDING_TITLE || /[\r\n]/.test(title)) {
      return {
        problem: `a finding's title must be one line of 1 to ${MAX_FINDING_TITLE} characters`,
      };
    }
    if (detail === "" || detail.length > MAX_FINDING_DETAIL) {
      return {
        problem: `a finding's detail must be text of 1 to ${MAX_FINDING_DETAIL} characters`,
      };
    }
    findings.push({ title, detail });
  }
  return { findings };
}

/**
 * A finding cut back to the bounds, for an image after it removed credential values: the
 * replacement can be longer than the value it replaces, and the runner refuses a longer text.
 */
export function withinFindingBounds(finding: OutOfScopeFinding): OutOfScopeFinding {
  return {
    title: finding.title.slice(0, MAX_FINDING_TITLE).trim(),
    detail: finding.detail.slice(0, MAX_FINDING_DETAIL).trim(),
  };
}
