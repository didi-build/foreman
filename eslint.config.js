import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Import boundaries from docs/decisions/0101-repo-layout-and-tooling.md.
const cloudflareImports = {
  group: ["cloudflare", "cloudflare/*", "@cloudflare/*", "wrangler", "wrangler/*"],
  message: "Cloudflare code belongs only in src/adapters/deploy/ (ADR 0101).",
};
const coreForbiddenImports = [
  {
    group: [
      "windmill-client",
      "windmill-client/*",
      "node:http",
      "node:https",
      "node:http2",
      "node:net",
      "http",
      "https",
      "http2",
      "net",
      "undici",
      "axios",
      "node-fetch",
    ],
    message:
      "src/core/ has no Windmill, HTTP or network imports. Define an interface and implement it in an adapter (ADR 0101).",
  },
  {
    group: ["pg", "pg/*", "postgres"],
    message:
      "src/core/ uses the store interface. Database drivers belong in src/adapters/store-postgres/ (ADR 0101).",
  },
  {
    group: [
      "**/adapters",
      "**/adapters/**",
      "**/api",
      "**/api/**",
      "**/flows",
      "**/flows/**",
    ],
    message:
      "src/core/ must not depend on adapters, the API or flows. They depend on the core (ADR 0101).",
  },
];

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
    files: ["src/**/*.ts"],
    ignores: ["src/adapters/deploy/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [cloudflareImports] }],
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [cloudflareImports, ...coreForbiddenImports] },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "src/core/ makes no network calls. Use an adapter (ADR 0101).",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "src/core/ uses static imports only, so the boundary rules can check them (ADR 0101).",
        },
      ],
    },
  },
);
