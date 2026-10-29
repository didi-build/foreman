import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

import foremanBoundaries, { CORE_ALLOWED_MODULES } from "./eslint/core-boundary.mjs";

// Boundaries from docs/decisions/0101-repo-layout-and-tooling.md (essentials 5 and 9).
const CODE_FILES = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";
const CORE_FILES = "src/core/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";
const CORE_TEST_FILES = "src/core/**/*.test.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

const cloudflareImports = {
  group: [
    "cloudflare",
    "cloudflare/*",
    "cloudflare:*",
    "@cloudflare/*",
    "wrangler",
    "wrangler/*",
  ],
  message:
    "Cloudflare code belongs only in src/adapters/deploy/ (essential 9, ADR 0101).",
};

/** Globals that reach the network, the process or a runtime outside plain logic. */
const coreForbiddenGlobals = [
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "process",
  "globalThis",
  "global",
  "require",
  "module",
  "Bun",
  "Deno",
  "Function",
].map((name) => ({
  name,
  message:
    "src/core/ is plain logic: no network, process or runtime access. Use an adapter (ADR 0101).",
}));

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", "coverage/", "test-results/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  {
    files: ["gallery/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    files: [CODE_FILES],
    ignores: ["src/adapters/deploy/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [cloudflareImports] }],
    },
  },
  {
    files: [CORE_FILES],
    // Inline comments cannot switch the boundary off (an agent could otherwise add one).
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    plugins: { foreman: foremanBoundaries },
    rules: {
      "foreman/core-imports": "error",
      "no-restricted-globals": ["error", ...coreForbiddenGlobals],
      // Code built from strings would slip past every check above.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(CallExpression, NewExpression)[callee.property.name='constructor']",
          message: "src/core/ may not build functions through .constructor (ADR 0101).",
        },
      ],
    },
  },
  {
    // Unit tests sit next to the code (ADR 0101), so a core test file may also import the test runner.
    files: [CORE_TEST_FILES],
    rules: {
      "foreman/core-imports": [
        "error",
        { allowedModules: [...CORE_ALLOWED_MODULES, "vitest"] },
      ],
    },
  },
);
