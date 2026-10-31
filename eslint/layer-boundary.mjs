// ESLint rule for the flow layer's boundary (build plan M3.1, ADR 0101). Flows are thin shells:
// a flow entry may import only the flow layer's own modules, the core and the adapters, and the
// rest of the code may never import a flow. `allowedDirs` and `allowedModules`, when given, are
// allow-lists; `forbiddenDirs` is a deny-list for code that may otherwise import anything.
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export const layerImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep each layer to the imports it may use (ADR 0101, M3.1).",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedDirs: { type: "array", items: { type: "string" } },
          allowedModules: { type: "array", items: { type: "string" } },
          forbiddenDirs: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      outside: "'{{spec}}' is outside the folders this file may import: {{allowed}}.",
      forbidden: "'{{spec}}' is in {{dir}}, which this file may not import.",
      notAllowed:
        "'{{spec}}' is not a module this file may import. Allowed: {{allowed}}.",
      dynamic:
        "Use static imports with a literal path only, so this rule can check them.",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const toDir = (dir) => resolve(context.cwd, dir);
    const allowedDirs = options.allowedDirs?.map(toDir);
    const forbiddenDirs = (options.forbiddenDirs ?? []).map(toDir);
    const allowedModules = options.allowedModules
      ? new Set(options.allowedModules)
      : null;
    const fileDir = dirname(context.filename);

    function check(node, source) {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") {
        context.report({ node, messageId: "dynamic" });
        return;
      }
      const spec = source.value;
      if (spec.startsWith(".") || isAbsolute(spec)) {
        const target = resolve(fileDir, spec);
        const blocked = forbiddenDirs.find((dir) => isInside(target, dir));
        if (blocked) {
          const dir = relative(context.cwd, blocked);
          context.report({ node, messageId: "forbidden", data: { spec, dir } });
        } else if (allowedDirs && !allowedDirs.some((dir) => isInside(target, dir))) {
          const allowed = options.allowedDirs.join(", ");
          context.report({ node, messageId: "outside", data: { spec, allowed } });
        }
      } else if (allowedModules && !allowedModules.has(spec)) {
        const allowed = [...allowedModules].join(", ") || "none";
        context.report({ node, messageId: "notAllowed", data: { spec, allowed } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => context.report({ node, messageId: "dynamic" }),
    };
  },
};

export default { rules: { "layer-imports": layerImportsRule } };
