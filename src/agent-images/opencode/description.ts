// The description of the pull request the wrapper opens (N-44, D-235, O-148, D-426). The builder's
// final message, without its foreman-report block, comes first (./report.ts). Under it the wrapper
// always adds the facts of the branch, in plain code: the subjects of the branch's commits and the
// files it changes, read from GitHub's compare of the default branch and the run's branch, after a
// line saying Foreman added them. A model's summary can be cut short or be no summary at all (on
// didi-build/rehearsal#9 it was one opening line, "Here's a summary of what was accomplished:"),
// so the facts are there whatever the model wrote. When the final message gives no summary at all,
// as on didi-build/rehearsal#7 whose final message was the block alone, the description is a fixed
// line saying so, then the same facts. No model writes the facts, and no text is made up: the
// subjects are the commits' own first lines.
//
// The compare is read only when a pull request is opened, never when one is reused. If GitHub
// refuses it, or its answer is not in the expected shape (an answer over the client's size limit
// reads as not JSON), the description is the summary alone, or the fixed line alone when there is
// no summary: the pull request is still opened, since a missing description is no reason to fail
// a run whose work is pushed. Each line of the facts is cut to a fixed length and control
// characters become spaces, so a commit subject or a file name cannot add lines of its own. The
// caller removes credential values and the PR step caps the length (MAX_BODY in
// ./pull-request.ts).
import type { GitHubApi } from "./github.ts";
import { branchPath } from "./pull-request.ts";

/** The description when the run gave no summary and the branch could not be read. */
export const NO_SUMMARY = "The run gave no summary.";
/** The first line of a description the wrapper wrote from the branch. */
export const WRITTEN_FROM_BRANCH = `${NO_SUMMARY} Foreman wrote this description from the branch on GitHub: its commits and the files it changes.`;
/** The line before the facts the wrapper adds under the run's own summary (D-426). */
export const ADDED_FROM_BRANCH =
  "Foreman added this part from the branch on GitHub: its commits and the files it changes.";

/** Commits listed, and the compare's page size, so GitHub sends no more commits than this. */
export const MAX_LISTED_COMMITS = 50;
export const MAX_LISTED_FILES = 100;
/** A commit subject or a file name is cut to this many characters. */
const MAX_LINE = 200;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line of text: control characters as spaces, trimmed and cut. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 3)}...` : flat;
}

/** A file name as inline code, or plain when it holds a backtick. */
const codeName = (name: string): string =>
  name.includes("`") ? oneLine(name) : `\`${oneLine(name)}\``;

/** `- and 3 more commits`, or nothing when every item is listed. */
const more = (left: number, what: string): string[] =>
  left > 0 ? [`- and ${left} more ${what}`] : [];

/**
 * The branch's facts from GitHub's compare answer (`GET /repos/{repo}/compare/{base}...{head}`):
 * `total_commits`, `commits[].commit.message` and `files[]` with `filename`, `status` and, for a
 * rename, `previous_filename`. Null when the answer is not in that shape or lists no commit.
 */
export function branchFacts(body: unknown): string | null {
  if (!isObject(body) || !Array.isArray(body.commits) || !Array.isArray(body.files)) {
    return null;
  }
  const subjects: string[] = [];
  for (const commit of body.commits) {
    const message =
      isObject(commit) && isObject(commit.commit) ? commit.commit.message : null;
    if (typeof message !== "string") return null;
    subjects.push(oneLine(message.split(/\r?\n/)[0] ?? "") || "(no subject)");
  }
  if (subjects.length === 0) return null;
  const files: string[] = [];
  for (const file of body.files) {
    if (!isObject(file) || typeof file.filename !== "string" || file.filename === "") {
      return null;
    }
    const status = typeof file.status === "string" ? oneLine(file.status) : "changed";
    const from =
      status === "renamed" && typeof file.previous_filename === "string"
        ? ` from ${codeName(file.previous_filename)}`
        : "";
    files.push(`- ${codeName(file.filename)} (${status}${from})`);
  }
  const total =
    typeof body.total_commits === "number" &&
    Number.isSafeInteger(body.total_commits) &&
    body.total_commits >= subjects.length
      ? body.total_commits
      : subjects.length;
  const listed = subjects.slice(0, MAX_LISTED_COMMITS);
  return [
    "Commits:",
    ...listed.map((subject) => `- ${subject}`),
    ...more(total - listed.length, "commits"),
    "",
    "Changed files:",
    ...(files.length === 0 ? ["- none listed by GitHub"] : []),
    ...files.slice(0, MAX_LISTED_FILES),
    ...more(files.length - MAX_LISTED_FILES, "files"),
  ].join("\n");
}

/**
 * The description: the run's summary, then the branch's facts after ADDED_FROM_BRANCH; or, with no
 * summary, WRITTEN_FROM_BRANCH and the facts. Without facts, the summary alone or NO_SUMMARY.
 */
export function pullRequestBody(summary: string, facts: string | null): string {
  if (summary === "") return facts ? `${WRITTEN_FROM_BRANCH}\n\n${facts}` : NO_SUMMARY;
  return facts ? `${summary}\n\n---\n\n${ADDED_FROM_BRANCH}\n\n${facts}` : summary;
}

/**
 * Reads the compare of the default branch and the run's branch and gives the description for the
 * run's summary (pullRequestBody), without the facts when GitHub refuses the compare or answers in
 * another shape. Never throws.
 */
export async function describeBranch(options: {
  github: GitHubApi;
  /** `owner/name`. */
  repository: string;
  /** The repository's default branch, as GitHub named it. */
  base: string;
  branch: string;
  /** The run's final message without its foreman-report block; empty when it gave none. */
  summary: string;
}): Promise<string> {
  const { github, repository, base, branch, summary } = options;
  let facts: string | null = null;
  try {
    // The file list is on the first page only, with up to 300 files (O-136).
    const compared = await github(
      "GET",
      `/repos/${repository}/compare/${branchPath(base)}...${branchPath(branch)}?per_page=${MAX_LISTED_COMMITS}`,
    );
    if (compared.status === 200) facts = branchFacts(compared.body);
  } catch {
    facts = null;
  }
  return pullRequestBody(summary, facts);
}
