// Seam: repo guard and service process (D-364, O-117). Every production connection to the state
// store is built by the TLS builder (src/adapters/store-postgres/tls.ts): no other code makes a
// pool or a client, the state API's and the receiver's images carry the CA certificate at the
// path the code reads, and both services build their pool through the builder when they start,
// so a refused setting stops them. The runner's composition is checked in
// test/flows/compose.test.ts, the builder itself in src/adapters/store-postgres/tls.test.ts.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_WITHOUT_TLS_ENV,
  SUPABASE_CA_PATH,
} from "../src/adapters/store-postgres/tls.ts";
import { secretEnvName } from "../src/service-kit/config.ts";

const BUILDER = "src/adapters/store-postgres/tls.ts";
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : codeFiles(path);
    return CODE.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name) ? [path] : [];
  });
}

/** Production code: everything outside the tests that could open a database connection. */
const productionFiles = ["src", "flows", "infra", "scripts", ".github/scripts"].flatMap(
  codeFiles,
);

describe("database connections (repo guard: D-364, O-117)", () => {
  it("finds the production code, so the checks below cannot pass on an empty list", () => {
    expect(productionFiles).toContain("src/api/main.ts");
    expect(productionFiles).toContain(BUILDER);
  });

  it("makes every pool from the builder's config, and no client outside the builder", () => {
    const makers = new Map<string, string[]>();
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      // Only the default import, so `new pg.Pool(` is the one way to make a pool.
      expect(source, file).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']pg["']/);
      expect(source, file).not.toMatch(/require\(\s*["']pg["']\s*\)/);
      expect(source, file).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s*["']pg["']/);
      for (const match of source.matchAll(/new\s+pg\.(Pool|Client)\s*\(/g)) {
        const argument = source
          .slice(match.index + match[0].length)
          .replace(/\s+/g, "");
        if (file === BUILDER) continue;
        expect(match[1], `${file} makes a pg.Client`).toBe("Pool");
        expect(
          argument.startsWith("config.database)") ||
            argument.startsWith("databasePoolConfig("),
          `${file} makes a pool from something other than the TLS builder's config`,
        ).toBe(true);
        makers.set(file, [...(makers.get(file) ?? []), match[1]]);
      }
    }
    expect([...makers.keys()].sort()).toEqual([
      "flows/lib/compose.ts",
      "src/adapters/store-postgres/migrate.ts",
      "src/api/main.ts",
      "src/github-receiver/main.ts",
    ]);
  });

  it("sets the local opt-out in no deployment: infrastructure, workflows, images or flows", () => {
    const deployment = [
      ...codeFiles("infra"),
      ...readdirSync(".github/workflows").map((name) =>
        join(".github/workflows", name),
      ),
      ...readdirSync("src", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join("src", entry.name, "Dockerfile"))
        .filter((path) => existsSync(path)),
      "flows/windmill.yaml",
    ];
    expect(deployment).toContain("src/api/Dockerfile");
    for (const file of deployment) {
      expect(readFileSync(file, "utf8"), file).not.toContain(LOCAL_WITHOUT_TLS_ENV);
    }
  });

  it.each(["src/api/Dockerfile", "src/github-receiver/Dockerfile"])(
    "%s copies the CA certificate to the path the code reads",
    (dockerfile) => {
      const lines = readFileSync(dockerfile, "utf8").split("\n");
      expect(lines).toContain("WORKDIR /app");
      const copies = lines
        .filter((line) => /^COPY\s/.test(line))
        .map((line) => line.split(/\s+/).slice(1))
        .filter(
          ([from, to]) =>
            from !== undefined &&
            (SUPABASE_CA_PATH === from || SUPABASE_CA_PATH.startsWith(`${from}/`)) &&
            to === `./${from}`,
        );
      expect(copies.length, dockerfile).toBe(1);
    },
  );

  it("keeps the CA certificate in the image build context", () => {
    /** A .dockerignore line as a regular expression: `**` + `/`, `*` and `?` as Docker reads them. */
    const pattern = (line: string) => {
      let source = "";
      for (let i = 0; i < line.length; i += 1) {
        if (line.startsWith("**/", i)) {
          source += "(?:.*/)?";
          i += 2;
        } else if (line[i] === "*") source += "[^/]*";
        else if (line[i] === "?") source += "[^/]";
        else source += (line[i] ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${source}$`);
    };
    const excluded = readFileSync(".dockerignore", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
      .map(pattern);
    const parts = SUPABASE_CA_PATH.split("/");
    const paths = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    for (const path of paths) {
      for (const rule of excluded)
        expect(rule.test(path), `${rule} excludes ${path}`).toBe(false);
    }
    expect(pattern("infra").test("infra")).toBe(true);
    expect(pattern("**/*.test.ts").test("src/a/b.test.ts")).toBe(true);
  });
});

/** Made up for these tests. */
const PASSWORD = "not-a-real-password";
const REMOTE = `postgresql://service.example:${PASSWORD}@pooler.example.test:5432/postgres`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return { child, exited, output: () => output };
}

const WINDMILL = {
  WINDMILL_HOST: "windmill.example.com",
  WINDMILL_WORKSPACE: "process-check",
  HTTPS_PROXY: "http://127.0.0.1:1",
};

const SERVICES = [
  {
    name: "state API",
    entry: "src/api/main.ts",
    env: async () => ({
      ...WINDMILL,
      PORT: String(await freePort()),
      PUBLIC_PORT: String(await freePort()),
    }),
  },
  {
    name: "GitHub receiver",
    entry: "src/github-receiver/main.ts",
    env: async () => ({
      ...WINDMILL,
      PORT: String(await freePort()),
      [secretEnvName("platform/github/runner-webhook-secret")]:
        "not-a-real-webhook-secret",
      GITHUB_DEVELOPER_APP_LOGIN: "example-developer[bot]",
      GITHUB_DESIGNER_APP_LOGIN: "example-designer[bot]",
      GITHUB_RUNNER_APP_SLUG: "example-runner",
    }),
  },
];

describe.skipIf(process.platform === "win32")(
  "database TLS at service start (integration: service process, O-117)",
  () => {
    it.each(SERVICES)(
      "the $name builds its pool with the TLS builder and refuses the local opt-out for a remote host",
      async ({ entry, env }) => {
        const service = start(entry, {
          ...(await env()),
          DATABASE_URL: REMOTE,
          [LOCAL_WITHOUT_TLS_ENV]: "1",
        });
        expect(await service.exited).toBe(1);
        expect(service.output()).toContain(
          `DATABASE_URL cannot be used. ${LOCAL_WITHOUT_TLS_ENV} is set, but the database host is not localhost, 127.0.0.1, ::1 or a Unix socket.`,
        );
        expect(service.output()).not.toContain(PASSWORD);
        expect(service.output()).not.toContain("pooler.example.test");
      },
    );

    it("`npm run db:migrate` builds its pool with the TLS builder and refuses the local opt-out for a remote host", async () => {
      const migrate = start("src/adapters/store-postgres/migrate.ts", {
        MIGRATION_DATABASE_URL: REMOTE,
        [LOCAL_WITHOUT_TLS_ENV]: "1",
      });
      expect(await migrate.exited).toBe(1);
      expect(migrate.output()).toContain(
        `MIGRATION_DATABASE_URL cannot be used. ${LOCAL_WITHOUT_TLS_ENV} is set, but the database host is not localhost, 127.0.0.1, ::1 or a Unix socket.`,
      );
      expect(migrate.output()).not.toContain(PASSWORD);
    });

    it.each(SERVICES)(
      "the $name starts with the committed CA certificate and a pasted sslmode",
      async ({ entry, env }) => {
        const settings = await env();
        const service = start(entry, {
          ...settings,
          DATABASE_URL: `${REMOTE}?sslmode=disable`,
        });
        try {
          await vi.waitFor(() => expect(service.output()).toContain('"listening"'), {
            timeout: 10_000,
          });
          const health = await fetch(`http://127.0.0.1:${settings.PORT}/health`);
          expect(health.status).toBe(200);
        } finally {
          service.child.kill("SIGTERM");
        }
        expect(await service.exited).toBe(0);
        expect(service.output()).not.toContain(PASSWORD);
      },
    );
  },
);
