// ESLint rule for the core library boundary (ADR 0101, essential 5). An allow-list, not a
// deny-list: a file in the core may import only other core files and a few pure Node modules.
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Pure Node modules the core may use. No network, file system, process or child processes. */
export const CORE_ALLOWED_MODULES = ["node:assert", "node:crypto", "node:util"];

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export const coreImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep src/core/ free of anything outside the core (ADR 0101).",
    },
    schema: [
      {
        type: "object",
        properties: {
          coreDir: { type: "string" },
          allowedModules: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      outside:
        "src/core/ may only import files inside src/core/. '{{spec}}' is outside it (ADR 0101).",
      notAllowed:
        "src/core/ may not import '{{spec}}'. Allowed outside modules: {{allowed}}. Define an interface and implement it in an adapter (ADR 0101).",
      dynamic:
        "src/core/ uses static imports with a literal path only, so this rule can check them (ADR 0101).",
      require: "src/core/ may not use require or createRequire (ADR 0101).",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const coreDir = resolve(context.cwd, options.coreDir ?? "src/core");
    const allowed = new Set(options.allowedModules ?? CORE_ALLOWED_MODULES);
    const fileDir = dirname(context.filename);

    function check(node, source) {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") {
        context.report({ node, messageId: "dynamic" });
        return;
      }
      const spec = source.value;
      if (spec.startsWith(".") || isAbsolute(spec)) {
        if (!isInside(resolve(fileDir, spec), coreDir))
          context.report({ node, messageId: "outside", data: { spec } });
      } else if (!allowed.has(spec)) {
        context.report({
          node,
          messageId: "notAllowed",
          data: { spec, allowed: [...allowed].join(", ") },
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => context.report({ node, messageId: "dynamic" }),
      TSExternalModuleReference: (node) =>
        context.report({ node, messageId: "require" }),
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          ["require", "createRequire"].includes(node.callee.name)
        ) {
          context.report({ node, messageId: "require" });
        }
      },
    };
  },
};

export default { rules: { "core-imports": coreImportsRule } };
