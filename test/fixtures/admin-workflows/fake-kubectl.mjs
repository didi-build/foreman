// A stand-in for kubectl in test/admin-workflow-scripts.test.ts. It keeps a small cluster in the
// JSON file FAKE_STATE and appends every call (its arguments and its stdin, kept apart) to the
// JSON lines file FAKE_LOG, so a test can check a secret value reached stdin and never an
// argument. It answers only the calls the admin workflows' scripts make.
//
// State: { namespaces: [names], live: {"<file name>": object}, secrets: {name: {rv, data}},
//   cluster: [rendered objects, for RBAC], pods: {"<ns>/<name>": {phase, nodeName, log}},
//   nodes: [node objects], failRollouts: [deployment names], diffExit: number,
//   kubeconfigToken, kubeconfigServer, kubeconfigCaData: the credential's token, server URL and
//   certificate-authority-data, endpointSlices: the `kubernetes` Service's EndpointSlice list,
//   serviceAccounts: ["<ns>/<name>"], tokenSecrets: {name: {object, polls}} as applied,
//   runnerToken: the token the cluster fills a token Secret with, after tokenFillAfterPolls reads }
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const readStdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};
const flag = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
};
const namespaceFlag = () => flag("-n") ?? flag("--namespace");
const takesStdin =
  (args[0] === "create" && args.some((a) => a.endsWith("=/dev/stdin"))) ||
  args.includes("--filename=-") ||
  (flag("--filename") === "-" && args[0] !== "diff");
const stdin = takesStdin ? readStdin() : "";
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, stdin })}\n`);

const out = (text) => process.stdout.write(text);
const fileName = (o) => {
  const [group, version] = o.apiVersion.includes("/")
    ? o.apiVersion.split("/")
    : ["", o.apiVersion];
  return `${group ? `${group}.` : ""}${version}.${o.kind}.${o.metadata.namespace ?? ""}.${o.metadata.name}`;
};

function canI() {
  const [verb, target] = args.slice(2);
  const who = flag("--as");
  if (!who) {
    out("yes\n");
    return 0;
  }
  const [, , saNamespace, saName] = who.split(":");
  const [resource, ...groupParts] = target.split(".");
  const group = groupParts.join(".");
  const sub = flag("--subresource");
  const ns = args.includes("--all-namespaces") ? undefined : namespaceFlag();
  const objects = state.cluster ?? [];
  const allowed =
    ns !== undefined &&
    objects
      .filter(
        (o) =>
          o.kind === "RoleBinding" &&
          o.metadata.namespace === ns &&
          o.subjects.some(
            (s) =>
              s.kind === "ServiceAccount" &&
              s.name === saName &&
              s.namespace === saNamespace,
          ),
      )
      .map((b) =>
        objects.find(
          (o) =>
            o.kind === "Role" &&
            o.metadata.namespace === ns &&
            o.metadata.name === b.roleRef.name,
        ),
      )
      .filter(Boolean)
      .some((role) =>
        role.rules.some(
          (rule) =>
            (rule.apiGroups.includes(group) || rule.apiGroups.includes("*")) &&
            rule.resources.includes(sub ? `${resource}/${sub}` : resource) &&
            (rule.verbs.includes(verb) || rule.verbs.includes("*")),
        ),
      );
  out(allowed ? "yes\n" : "no\n");
  return allowed ? 0 : 1;
}

function diff() {
  const list = JSON.parse(readFileSync(flag("--filename"), "utf8"));
  if (state.diffExit && state.diffExit > 1) {
    process.stderr.write("error: the server could not dry-run the objects\n");
    return state.diffExit;
  }
  const root = mkdtempSync(join(tmpdir(), "fake-kubectl-diff-"));
  const live = join(root, "LIVE");
  const merged = join(root, "MERGED");
  spawnSync("mkdir", ["-p", live, merged]);
  for (const o of list.items) {
    const name = fileName(o);
    const current = state.live?.[name];
    writeFileSync(join(live, name), current ? JSON.stringify(current, null, 2) : "");
    writeFileSync(join(merged, name), JSON.stringify(o, null, 2));
  }
  const result = spawnSync(process.env.KUBECTL_EXTERNAL_DIFF, [live, merged], {
    encoding: "utf8",
  });
  out(result.stdout);
  process.stderr.write(result.stderr);
  return result.status ?? 2;
}

function main() {
  const [verb, kind, name] = args;
  if (verb === "auth" && kind === "can-i") return canI();
  if (verb === "diff") return diff();
  if (verb === "config" && kind === "view") {
    const path = flag("--output") ?? "";
    if (path.includes(".users[0].user.token")) out(state.kubeconfigToken ?? "");
    if (path.includes(".clusters[0].cluster.server")) out(state.kubeconfigServer ?? "");
    if (path.includes(".clusters[0].cluster.certificate-authority-data"))
      out(state.kubeconfigCaData ?? "");
    return 0;
  }
  if (verb === "get" && kind === "serviceaccount") {
    if ((state.serviceAccounts ?? []).includes(`${namespaceFlag()}/${name}`)) {
      out(`serviceaccount/${name}\n`);
      return 0;
    }
    process.stderr.write(
      `Error from server (NotFound): serviceaccounts "${name}" not found\n`,
    );
    return 1;
  }
  if (
    verb === "get" &&
    kind === "secret" &&
    (flag("--output") ?? "").includes(".data.token")
  ) {
    const secret = state.tokenSecrets?.[name];
    if (!secret) {
      process.stderr.write(
        `Error from server (NotFound): secrets "${name}" not found\n`,
      );
      return 1;
    }
    secret.polls += 1;
    save();
    if (state.runnerToken && secret.polls > (state.tokenFillAfterPolls ?? 0))
      out(Buffer.from(state.runnerToken).toString("base64"));
    return 0;
  }
  if (verb === "get" && kind === "endpointslices") {
    out(JSON.stringify(state.endpointSlices ?? { items: [] }));
    return 0;
  }
  if (verb === "get" && kind === "namespace") {
    if ((state.namespaces ?? []).includes(name)) out(`namespace/${name}\n`);
    return 0;
  }
  if (verb === "get" && kind === "secret") {
    out(state.secrets?.[name]?.rv ?? "");
    return 0;
  }
  if (verb === "create" && kind === "secret") {
    const secretName = args[3];
    const [key] = flag("--from-file").split("=");
    out(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: secretName, namespace: namespaceFlag() },
        data: { [key]: Buffer.from(stdin).toString("base64") },
      }),
    );
    return 0;
  }
  if (verb === "apply") {
    const object = JSON.parse(stdin);
    if (object.type === "kubernetes.io/service-account-token") {
      state.tokenSecrets ??= {};
      state.tokenSecrets[object.metadata.name] ??= { object, polls: 0 };
      save();
    } else if (object.kind === "Secret") {
      state.secrets ??= {};
      const before = state.secrets[object.metadata.name];
      const data = JSON.stringify(object.data);
      if (!before || before.data !== data) {
        state.rv = (state.rv ?? 100) + 1;
        state.secrets[object.metadata.name] = { rv: String(state.rv), data };
      }
      save();
    }
    out(`${object.kind.toLowerCase()}/${object.metadata.name} serverside-applied\n`);
    return 0;
  }
  if (verb === "rollout") {
    const deployment = args[2].replace("deployment/", "");
    if (kind === "status" && (state.failRollouts ?? []).includes(deployment)) return 1;
    return 0;
  }
  if (verb === "delete" && kind === "pod") return 0;
  if (verb === "create" && flag("--filename") === "-") {
    const pod = JSON.parse(stdin);
    state.created ??= [];
    state.created.push(pod);
    save();
    return 0;
  }
  if (verb === "get" && kind === "pod") {
    const pod = state.pods?.[`${namespaceFlag()}/${name}`] ?? {};
    const path = flag("--output");
    if (path?.includes(".status.phase")) out(pod.phase ?? "");
    if (path?.includes(".spec.nodeName")) out(pod.nodeName ?? "");
    return 0;
  }
  if (verb === "logs") {
    out(`${state.pods?.[`${namespaceFlag()}/${kind}`]?.log ?? ""}\n`);
    return 0;
  }
  if (verb === "get" && kind === "node") {
    out(
      JSON.stringify((state.nodes ?? []).find((n) => n.metadata.name === name) ?? {}),
    );
    return 0;
  }
  if (verb === "get" && kind === "nodes") {
    out(JSON.stringify({ items: state.nodes ?? [] }));
    return 0;
  }
  if (verb === "get" && kind === "pods") {
    const ns = namespaceFlag();
    out(
      JSON.stringify({
        items: Object.entries(state.pods ?? {})
          .filter(([key]) => key.startsWith(`${ns}/`))
          .map(([key, pod]) => ({
            metadata: { name: key.split("/")[1] },
            spec: { nodeName: pod.nodeName ?? null },
          })),
      }),
    );
    return 0;
  }
  process.stderr.write(`fake kubectl: unexpected call: ${args.join(" ")}\n`);
  return 3;
}

process.exitCode = main();
