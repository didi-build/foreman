// Option capture (D-242, D-243 rule 2, N-70 point (3), O-88). The Designer commits two or three
// exploration options under `design/<area>/<feature>/options/<name>/` on the item's branch, and
// CI renders the option folders the pull request changes at its head into the `options` bundle
// (scripts/render-screenshots.ts, O-81). The runner, never an agent, then captures them: it
// reads that bundle at the head through the `ScreenshotBundles` port, records one `screenshot`
// evidence per option of the item's feature on the head commit, and opens one `visual_approval`
// request owned by Didi on the item's visual-approval topic (`visual-approval:<item id>`) that
// lists the option names (`payload.options`). Those are exactly what the readers already read:
// the approval form's Options field (src/core/approvals.ts), the Council's visual call
// (./visual-call.ts) and QA's visual comparison (./visual-comparison.ts), which finds the
// approved option's folder and capture commit from this evidence.
//
// When it captures. The item is in the state the move guarded by `options_attached` leaves (In
// design exploration, from the contracts), its latest Designer run ended `success`, and the
// item's PR has a head (the newest `ci_run`). The PR's own option folders, from that `ci_run`'s
// `changedPaths`, name the item's feature: they must all lie in one feature folder, or capture
// refuses. Only the bundle's options in that feature's `options/` folder are kept, so another
// feature's folder in the bundle is ignored. A bundle from a PR that changes the screenshot
// pipeline, or whose changed paths are not recorded, is never read (D-279,
// ./screenshot-pipeline.ts). The manifest is read with the comparison's own strict reader, and
// every kept option's file must match the SHA-256 its manifest gives.
//
// How many options. The Designer's rule says two or three. Fewer than 2 kept options refuses
// (Didi would have nothing to choose between); more than the Council's visual call can show
// (`VISUAL_CALL_LIMITS.options`, 10) refuses too, so every request capture opens can be shown
// to both Didi and the Council. Between 4 and 10 is captured as it is.
//
// The write. In one transaction that reads the kill switch and dry run and locks the item first:
// the screenshots and the request, or nothing. A newer head supersedes an older open request on
// the topic (the library's one open request per topic, schema invariant 5); a repeat for the same
// head (`payload.captureCommitSha`) opens nothing, whatever that request's status, so an answered
// request is not asked again until the Designer pushes a new head. Evidence is append-only, and
// the readers take the latest screenshot per option name.
//
// Refusals and waits write nothing. Refusals carry fixed text (`CAPTURE_REFUSAL_TEXT`) and never
// quote a file, a path or an id. Plain logic over an injected store, contracts, clock, id source
// and screenshot port (D-162).
import { createHash } from "node:crypto";

import type { Contracts, GuardRegistry } from "./contracts.ts";
import { visualApprovalTopic } from "./guards/design.ts";
import { latest, readCiRun } from "./guards/evidence.ts";
import { optionFolderOf } from "./guards/options.ts";
import { createLibrary, type Clock, type IdSource } from "./library.ts";
import {
  CHANGED_PATHS_UNKNOWN_REASON,
  SCREENSHOT_PIPELINE_REASON,
  screenshotPipelineAt,
} from "./screenshot-pipeline.ts";
import type { GateRequest, Json, Node, Run, Store, StoreOps } from "./store.ts";
import { VISUAL_CALL_LIMITS } from "./visual-call.ts";
import {
  optionScreenshotPayload,
  readScreenshotManifest,
  type OptionShot,
  type ScreenshotBundle,
  type ScreenshotBundles,
} from "./visual-comparison.ts";

/** The guard of the move into Waiting for Didi, whose evidence capture makes (contracts/machine-2). */
export const OPTIONS_GUARD = "options_attached";

/** The fewest options a request lists: Didi chooses between them (D-243 rule 2). */
export const MIN_CAPTURED_OPTIONS = 2;
/** The most: as many as the Council's visual call shows (./visual-call.ts). */
export const MAX_CAPTURED_OPTIONS = VISUAL_CALL_LIMITS.options;

/** The fixed question on every visual-approval request capture opens. */
export const VISUAL_APPROVAL_QUESTION =
  "The Designer's options for this item are ready. Approve one option, or Request changes or Reject with feedback.";

export type CaptureRefusal =
  /** The PR changes the screenshot pipeline (D-279). */
  | "screenshot_pipeline_changed"
  /** The head's `ci_run` lists no changed paths, so the pipeline cannot be checked (D-279). */
  | "changed_paths_unknown"
  /** The PR changes no option folder. */
  | "no_option_folders"
  /** The PR changes option folders of more than one feature. */
  | "more_than_one_feature"
  /** The screenshot port failed to read the bundle. */
  | "bundle_unreadable"
  | "bundle_invalid"
  | "too_few_options"
  | "too_many_options"
  /** A kept option's file is missing from the bundle or does not match its SHA-256. */
  | "option_file_changed";

/** The fixed text of each refusal. Never a file, a path or an id. */
export const CAPTURE_REFUSAL_TEXT: Readonly<Record<CaptureRefusal, string>> = {
  screenshot_pipeline_changed: SCREENSHOT_PIPELINE_REASON,
  changed_paths_unknown: CHANGED_PATHS_UNKNOWN_REASON,
  no_option_folders: "the pull request changes no exploration option folder",
  more_than_one_feature:
    "the pull request changes exploration options of more than one feature",
  bundle_unreadable: "CI's options screenshots could not be read",
  bundle_invalid: "CI's options screenshot manifest is not valid",
  too_few_options: `fewer than ${MIN_CAPTURED_OPTIONS} options were rendered for the item's feature`,
  too_many_options: `more than ${MAX_CAPTURED_OPTIONS} options were rendered for the item's feature`,
  option_file_changed: "an option's screenshot does not match CI's manifest",
};

export type CaptureStep =
  | {
      nodeId: string;
      step: "opened";
      gateRequestId: string;
      /** The older open request this one superseded, if any. */
      supersededId: string | null;
      headSha: string;
      options: string[];
      /** The Designer run whose report asks for the move into Waiting for Didi. */
      designerRunId: string;
    }
  | {
      nodeId: string;
      step: "already_captured";
      gateRequestId: string;
      /** Whether that request is still open. */
      open: boolean;
      designerRunId: string;
    }
  | { nodeId: string; step: "refused"; reason: CaptureRefusal; text: string }
  | {
      nodeId: string;
      step:
        | "no_item"
        | "not_exploring"
        | "no_designer_report"
        | "designer_running"
        | "no_head"
        /** No `options` bundle at the head yet: CI has not rendered it. Asked again later. */
        | "bundle_missing"
        /** The item moved, or its head changed, while the bundle was read. Asked again later. */
        | "changed_meanwhile"
        | "kill_switch"
        | "dry_run";
    };

export interface OptionCaptureOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  screenshots: ScreenshotBundles;
}

const ACTOR_ID = "option_capture";

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The head commit a capture request was opened for (`payload.captureCommitSha`). */
export const captureCommitOf = (gate: GateRequest | undefined): string | null => {
  const sha = isObject(gate?.payload) ? gate.payload.captureCommitSha : undefined;
  return typeof sha === "string" ? sha : null;
};

/** The `ref` of one captured option's screenshot: one per head and option name. */
export const optionScreenshotRef = (headSha: string, option: string): string =>
  `runner:option_screenshot:${headSha}:${option}`;

/**
 * The feature folder `design/<area>/<feature>` of each option folder among a PR's changed paths,
 * sorted and unique.
 */
export function featuresOf(changedPaths: readonly string[]): string[] {
  const features = changedPaths
    .map(optionFolderOf)
    .filter((f): f is string => f !== null)
    .map((folder) => folder.slice(0, folder.lastIndexOf("/options/")));
  return [...new Set(features)].sort();
}

export function createOptionCaptures(options: OptionCaptureOptions) {
  const { store, contracts, clock, ids, screenshots } = options;
  const library = createLibrary(options);

  /** The states and tracks capture works in: those the move guarded by `options_attached` leaves. */
  const moves = contracts.transitions.filter(
    (m) => !m.escalation && m.guards.includes(OPTIONS_GUARD),
  );
  const exploring = (node: Node): boolean =>
    moves.some(
      (m) =>
        m.from === node.state &&
        (!m.tracks || (node.track !== null && m.tracks.includes(node.track))),
    );

  async function stopped(tx: StoreOps): Promise<"kill_switch" | "dry_run" | null> {
    if ((await tx.getSetting("kill_switch"))?.value === true) return "kill_switch";
    if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
    return null;
  }

  /** The newest request on the item's visual-approval topic, whatever its status. */
  async function newestRequest(
    ops: StoreOps,
    node: Node,
  ): Promise<GateRequest | undefined> {
    const requests = await ops.listGateRequests(
      node.projectId,
      visualApprovalTopic(node.id),
    );
    return [...requests].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
  }

  /** The item's latest Designer run, or null. */
  async function designerRun(ops: StoreOps, nodeId: string): Promise<Run | null> {
    return (
      latest((await ops.listRuns({ nodeId })).filter((r) => r.bot === "designer")) ??
      null
    );
  }

  const refuse = (nodeId: string, reason: CaptureRefusal): CaptureStep => ({
    nodeId,
    step: "refused",
    reason,
    text: CAPTURE_REFUSAL_TEXT[reason],
  });

  async function readBundle(
    repo: string,
    headSha: string,
  ): Promise<ScreenshotBundle | null | "unreadable"> {
    try {
      return await screenshots.read(repo, headSha, "options");
    } catch {
      // The port refuses until the runner App exists (D-178); any error is kept out of results.
      return "unreadable";
    }
  }

  async function fileMatches(bundle: ScreenshotBundle, shot: OptionShot) {
    try {
      const bytes = await bundle.file(shot.file);
      return bytes !== null && sha256(bytes) === shot.sha256;
    } catch {
      return false;
    }
  }

  return {
    /** Design items in a capture state: the ones the reconcile pass looks at. */
    async pending(): Promise<string[]> {
      const states = [...new Set(moves.map((m) => m.from))];
      const nodes = (
        await Promise.all(states.map((state) => store.listNodes({ state })))
      ).flat();
      return nodes.filter(exploring).map((n) => n.id);
    },

    /**
     * Captures the options at the item's PR head and opens Didi's request, or says why not.
     * Repeating it for the same head writes nothing more.
     */
    async capture(nodeId: string): Promise<CaptureStep> {
      const stop = await stopped(store);
      if (stop) return { nodeId, step: stop };
      const node = await store.getNode(nodeId);
      const project = node && (await store.getProject(node.projectId));
      if (!node || !project) return { nodeId, step: "no_item" };
      if (!exploring(node)) return { nodeId, step: "not_exploring" };
      const run = await designerRun(store, nodeId);
      if (!run) return { nodeId, step: "no_designer_report" };
      if (run.endedAt === null) return { nodeId, step: "designer_running" };
      if (run.outcome !== "success") return { nodeId, step: "no_designer_report" };
      const head = latest(await store.listEvidence({ nodeId, kind: "ci_run" }));
      const headSha = head?.commitSha;
      if (!head || !headSha) return { nodeId, step: "no_head" };

      const newest = await newestRequest(store, node);
      if (newest && captureCommitOf(newest) === headSha) {
        return {
          nodeId,
          step: "already_captured",
          gateRequestId: newest.id,
          open: newest.status === "open",
          designerRunId: run.id,
        };
      }

      // D-279: a bundle from a PR that changes how bundles are made is never read.
      const pipeline = await screenshotPipelineAt(store, nodeId, headSha);
      if (!pipeline.trusted) return refuse(nodeId, pipeline.reason);
      // The same `ci_run` the pipeline check read, so its changed paths are recorded.
      const ciAtHead = latest(
        await store.listEvidence({ nodeId, kind: "ci_run", commitSha: headSha }),
      );
      const changedPaths =
        (ciAtHead && readCiRun(ciAtHead.payload)?.changedPaths) ?? [];
      const features = featuresOf(changedPaths);
      if (features.length === 0) return refuse(nodeId, "no_option_folders");
      if (features.length > 1) return refuse(nodeId, "more_than_one_feature");
      const feature = features[0] as string;

      const bundle = await readBundle(project.repo, headSha);
      if (bundle === "unreadable") return refuse(nodeId, "bundle_unreadable");
      if (bundle === null) return { nodeId, step: "bundle_missing" };
      const read = readScreenshotManifest(bundle.manifest, headSha, "options");
      if ("problem" in read || read.manifest.kind !== "options") {
        return refuse(nodeId, "bundle_invalid");
      }
      const kept = read.manifest.options.filter(
        (o) => o.path === `${feature}/options/${o.option}`,
      );
      if (kept.length < MIN_CAPTURED_OPTIONS) return refuse(nodeId, "too_few_options");
      if (kept.length > MAX_CAPTURED_OPTIONS) return refuse(nodeId, "too_many_options");
      for (const shot of kept) {
        if (!(await fileMatches(bundle, shot))) {
          return refuse(nodeId, "option_file_changed");
        }
      }

      return store.transaction(async (tx): Promise<CaptureStep> => {
        const held = await stopped(tx);
        if (held) return { nodeId, step: held };
        const locked = await tx.getNodeForUpdate(nodeId);
        if (!locked || !exploring(locked)) return { nodeId, step: "changed_meanwhile" };
        const nowHead = latest(await tx.listEvidence({ nodeId, kind: "ci_run" }));
        const latestRun = await designerRun(tx, nodeId);
        if (nowHead?.commitSha !== headSha || latestRun?.id !== run.id) {
          return { nodeId, step: "changed_meanwhile" };
        }
        const again = await newestRequest(tx, locked);
        if (again && captureCommitOf(again) === headSha) {
          return {
            nodeId,
            step: "already_captured",
            gateRequestId: again.id,
            open: again.status === "open",
            designerRunId: run.id,
          };
        }
        const at = clock.now();
        for (const shot of kept) {
          await tx.insertEvidence({
            id: ids.next(),
            nodeId,
            runId: run.id,
            kind: "screenshot",
            ref: optionScreenshotRef(headSha, shot.option),
            commitSha: headSha,
            payload: optionScreenshotPayload(shot),
            recordedBy: "runner",
            recordedAt: at,
            supersedesId: null,
          });
        }
        const open = await tx.findOpenGateRequest(
          locked.projectId,
          visualApprovalTopic(nodeId),
        );
        const names = kept.map((o) => o.option);
        const request = await library.openGateRequestWith(tx, {
          projectId: locked.projectId,
          nodeId,
          topicKey: visualApprovalTopic(nodeId),
          kind: "visual_approval",
          owner: "didi",
          blocking: true,
          payload: {
            question: VISUAL_APPROVAL_QUESTION,
            options: names,
            captureCommitSha: headSha,
            openedBy: ACTOR_ID,
          },
        });
        return {
          nodeId,
          step: "opened",
          gateRequestId: request.id,
          supersededId: open?.id ?? null,
          headSha,
          options: names,
          designerRunId: run.id,
        };
      });
    },
  };
}

export type OptionCaptures = ReturnType<typeof createOptionCaptures>;
