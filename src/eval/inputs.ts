// Builds each case's run exactly as the runner builds a real run's task (ADR 0117, D-427): the
// input from the runner's own builders in src/core/, and the task file's other pieces from the
// role's bot file (contracts/bots/), checked with the runner's own task file check. The
// instructions are the bot file loader's `instructionsFor`, which flows/lib/tasks.ts uses too: the
// shared base, the task type's persona and the task's text (ADR 0119 slice 2), so the test
// measures the text real runs get. Nothing here writes a rule or an instruction of its own.
//
// - QA (`qa:review`): `taskInput` over the work item, the repository, the pull request, the head
//   commit and the pull request's change, as flows/lib/start-run.ts calls it, the change computed
//   from the case's trees (./change.ts, D-431); the evidence ids the run may cite; and the case's
//   tree as the workspace its read-only tools read (src/agent-images/claude-api/files.ts).
//   QA's answer schema is the verdict contract the image holds (verdict.ts), not a task file part.
// - Triage: the repo map built from the case's tree at the case's commit by the repo map adapter
//   and checked as the runner checks one, then `triageInput` with the plan; the answer schema from
//   the bot file, which the runner's answer check also uses.
// - The Council: `escalationInput` over the escalation as the runner gathers it, the bot file's
//   escalation schema, and the question's discussion (ADR 0119 slice 6e): the bot file's chair and
//   pull-in limit and the cast `councilCast` gives for the escalated item (`questionDiscussion`,
//   src/core/council-cast.ts), as the runner's `taskFor` gives a real Council task. The scoring
//   checks the run's discussion against the same (./scoring.ts).
//
// QA's and Triage's inputs end with the short summary of the project's records, as a real run's
// do (ADR 0119 slice 3a, src/core/run-context.ts). The case format holds no project records yet,
// so each case's summary says "No records yet." (`emptyRunContext`). This is a known gap: a later
// slice gives cases their own records, so the test also measures runs with a summary. The Council
// gets no summary, as in real runs.
//
// QA's and Triage's tasks list the context tools their bot file declares (`context_tools`, ADR
// 0119 slice 3c), as flows/lib/tasks.ts passes them; no bot file declares any yet (slice 3d). The
// weekly test job runs them against a state API with no records (src/agent-images/eval/week.ts).
//
// The image's fixed frame (the system text around the instructions, and the facts it adds after
// the fenced input) is applied when the set runs, by the weekly test job with the Messages API
// image's own frame builders (src/agent-images/eval/week.ts, D-432).
import {
  taskFileJson,
  type AgentTaskFile,
} from "../adapters/agent-runtime/kubernetes/task.ts";
import {
  instructionsFor,
  type BotFile,
  type BotFiles,
} from "../adapters/contracts-file/bot-files.ts";
import { buildRepoMap, readCheckout } from "../adapters/repo-map/typescript.ts";
import { questionDiscussion, type QuestionDiscussion } from "../core/council-cast.ts";
import { escalationInput } from "../core/council-input.ts";
import type { OutputSchema } from "../core/output-schema.ts";
import type { PullRequestChange } from "../core/github.ts";
import { checkRepoMap, type RepoMap } from "../core/repo-map.ts";
import { contextSection, emptyRunContext } from "../core/run-context.ts";
import { taskInput } from "../core/task-input.ts";
import { triageInput } from "../core/triage.ts";
import type { CouncilCase, EvalCase, QaCase, TriageCase } from "./cases.ts";
import { caseChange } from "./change.ts";

interface RunCommon {
  caseId: string;
  taskType: string;
  /** The task file a real run of this role gets, checked by `taskFileJson`. */
  task: AgentTaskFile;
}

export interface QaRun extends RunCommon {
  role: "qa";
  headSha: string;
  /** The pull request's change its input carries (D-431). */
  change: PullRequestChange;
  evidenceIds: string[];
  /** The folder QA's read-only tools read: the case's tree. */
  workspace: string;
  /** Each file at the head commit, for checking the verdict's citations. */
  files: ReadonlyMap<string, string>;
}

export interface TriageRun extends RunCommon {
  role: "triage";
  /** The map Triage's input shows, which its answer is checked against. */
  map: RepoMap;
  outputSchema: OutputSchema;
}

export interface CouncilRun extends RunCommon {
  role: "council";
  outputSchema: OutputSchema;
  /** The question's discussion the task file carries, which the run's record is checked against. */
  discussion: QuestionDiscussion;
}

export type CaseRun = QaRun | TriageRun | CouncilRun;

export type RunFor<C extends EvalCase> = C extends QaCase
  ? QaRun
  : C extends TriageCase
    ? TriageRun
    : CouncilRun;

/** The summary a case's input ends with: the empty one, until cases carry records (slice 3a). */
function emptySummary(taskType: string) {
  const context = emptyRunContext(taskType);
  return context ? contextSection(context) : null;
}

/** The context tools a run of the role gets, as the runner passes them: only when declared. */
const contextToolsOf = (bot: BotFile): Pick<AgentTaskFile, "contextTools"> =>
  bot.contextTools ? { contextTools: [...bot.contextTools] } : {};

function schemaOf(bot: BotFile, kind: string): OutputSchema {
  const schema = bot.outputSchemas?.[kind];
  if (!schema) throw new Error(`the ${bot.role} bot file has no ${kind} output schema`);
  return structuredClone(schema);
}

function qaRun(c: QaCase, bots: BotFiles, cases: readonly EvalCase[]): QaRun {
  const { item } = c.input;
  const change = caseChange(c, cases);
  const input = taskInput({
    role: "qa",
    node: {
      id: item.id,
      title: item.title,
      body: {
        description: item.description,
        acceptanceCriteria: item.acceptanceCriteria,
      },
    },
    project: { repo: c.input.repo },
    prNumber: c.input.pullRequest,
    headSha: c.input.headSha,
    change,
    context: emptySummary(c.taskType),
  });
  const evidenceIds = c.input.evidence.map((e) => e.id);
  const task: AgentTaskFile = {
    foremanTask: 1,
    instructions: instructionsFor(bots.qa, c.taskType),
    input,
    nodeId: item.id,
    evidenceIds,
    ...contextToolsOf(bots.qa),
  };
  taskFileJson("qa", task);
  return {
    caseId: c.id,
    role: "qa",
    taskType: c.taskType,
    task,
    headSha: c.input.headSha,
    change,
    evidenceIds,
    workspace: c.tree.dir,
    files: c.tree.files,
  };
}

function triageRun(c: TriageCase, bots: BotFiles): TriageRun {
  const { commitSha } = c.input;
  const map = checkRepoMap(
    buildRepoMap(commitSha, readCheckout(c.tree.dir)),
    commitSha,
  );
  const outputSchema = schemaOf(bots.triage, "answer");
  const task: AgentTaskFile = {
    foremanTask: 1,
    instructions: instructionsFor(bots.triage, c.taskType),
    input: triageInput({
      idea: c.input.idea,
      plan: c.input.plan,
      map,
      lastRejection: null,
      councilNote: null,
      context: emptySummary(c.taskType),
    }),
    outputSchema,
    ...contextToolsOf(bots.triage),
  };
  taskFileJson("triage", task);
  return {
    caseId: c.id,
    role: "triage",
    taskType: c.taskType,
    task,
    map,
    outputSchema,
  };
}

function councilRun(c: CouncilCase, bots: BotFiles): CouncilRun {
  const { item, ...escalation } = c.input;
  const outputSchema = schemaOf(bots.council, c.input.question);
  const table = bots.council.discussion;
  if (!table) throw new Error("the council bot file has no discussion table");
  const discussion = questionDiscussion(table, {
    kind: c.input.question,
    node: { track: item.track },
  });
  const task: AgentTaskFile = {
    foremanTask: 1,
    instructions: instructionsFor(bots.council, c.taskType),
    input: escalationInput({
      node: {
        id: item.id,
        title: item.title,
        track: item.track,
        body: {
          description: item.description,
          acceptanceCriteria: item.acceptanceCriteria,
        },
      },
      escalatedFrom: escalation.escalatedFrom,
      why: escalation.why,
      counters: escalation.counters,
      failures: escalation.failures,
      qaFail: escalation.qaFail,
      stagingFails: escalation.stagingFails,
    }),
    outputSchema,
    discussion: { ...discussion, cast: [...discussion.cast] },
  };
  taskFileJson("council", task);
  return {
    caseId: c.id,
    role: "council",
    taskType: c.taskType,
    task,
    outputSchema,
    discussion,
  };
}

/**
 * The run of one case, built as the runner builds one. Throws if the runner would refuse it.
 * `cases` is every case (`loadCases`): a planted QA case's change starts from its base case's.
 */
export function buildCaseRun<C extends EvalCase>(
  c: C,
  bots: BotFiles,
  cases: readonly EvalCase[],
): RunFor<C>;
export function buildCaseRun(
  c: EvalCase,
  bots: BotFiles,
  cases: readonly EvalCase[],
): CaseRun {
  switch (c.role) {
    case "qa":
      return qaRun(c, bots, cases);
    case "triage":
      return triageRun(c, bots);
    case "council":
      return councilRun(c, bots);
  }
}
