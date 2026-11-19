// The weekly model test set's case list as the runner reads it (ADR 0117, D-428, O-156): each
// case's id and role, from `eval/cases/<id>/case.yaml`, which the Windmill deploy carries in each
// bundle (`bundle_files` in flows/windmill.yaml) and this reads through the bundle files reader.
// The weekly flow sizes the Job by it and names the cases the Job runs (`FOREMAN_EVAL_CASES`), so
// the Job runs what the runner sized; the Job refuses a case its image does not hold.
//
// Only the two fields are read here. The full check of a case (its input, tree and expectation)
// is the loader's, src/eval/cases.ts, which the test job's image runs and `npm run check` runs on
// every case; it reads the disk directly, so a flow cannot import it. Errors name the file and the
// field, never a value.
import { parse } from "yaml";

import { EVAL_ROLES, type EvalCaseRef, type EvalRole } from "../../core/model-eval.ts";
import { listBundledFolder, readBundledFile } from "../bundle-files/files.ts";

/** Where the cases live, and each one's file (src/eval/cases.ts `CASES_DIR`, `CASE_FILE`). */
export const EVAL_CASES_DIR = "eval/cases";
export const EVAL_CASE_FILE = "case.yaml";
/** A case id (src/eval/cases.ts `CASE_ID`). */
export const EVAL_CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every case's id and role, in id order. Throws naming the file and the field. */
export function readEvalCaseList(dir: string = EVAL_CASES_DIR): EvalCaseRef[] {
  const cases: EvalCaseRef[] = [];
  for (const name of listBundledFolder(dir).sort()) {
    const file = `${dir}/${name}/${EVAL_CASE_FILE}`;
    let raw: unknown;
    try {
      raw = parse(readBundledFile(file).toString("utf8"));
    } catch {
      throw new Error(`${file} cannot be read as YAML`);
    }
    const fields =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    if (typeof fields.id !== "string" || !EVAL_CASE_ID.test(fields.id)) {
      throw new Error(`${file}: id is not a case id`);
    }
    if (fields.id !== name) throw new Error(`${file}: id is not its folder's name`);
    if (!EVAL_ROLES.includes(fields.role as EvalRole)) {
      throw new Error(`${file}: role is not ${EVAL_ROLES.join(", ")}`);
    }
    cases.push({ id: fields.id, role: fields.role as EvalRole });
  }
  if (cases.length === 0) throw new Error(`${dir} holds no case`);
  return cases;
}
