# The repo map Job's image (D-275 (2), O-87). Build from the repo root:
#   docker build -f src/agent-images/repo-map/Dockerfile -t repo-map .
# A job, not a service: it listens on nothing and has no health endpoint. It downloads one
# repository's archive at one commit through its egress proxy, parses it with the TypeScript
# compiler (never runs it), prints one result line with the map and exits.
# With FOREMAN_JOB_MODE=scan it reads the same archive and prints the Scanner's stage 1 findings
# instead (O-92): fixed checks, parse only, with the YAML parser for contract files.
# No coding agent, no git, no shell tools and no model SDK: only Node, the compiler and the YAML
# parser.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NODE_ENV=production
# Node's fetch goes through HTTPS_PROXY, the Job's egress proxy, only with this set.
ENV NODE_USE_ENV_PROXY=1
WORKDIR /app

# The TypeScript compiler and the YAML parser at exact versions, from the image's own lockfile
# (deps/), which also tells Node the .ts files are ES modules. Install scripts are skipped.
COPY src/agent-images/repo-map/deps/package.json src/agent-images/repo-map/deps/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/service-kit/config.ts ./src/service-kit/config.ts
COPY src/core/repo-map.ts ./src/core/repo-map.ts
COPY src/core/scan.ts ./src/core/scan.ts
COPY src/core/out-of-scope-findings.ts ./src/core/out-of-scope-findings.ts
COPY src/core/github.ts ./src/core/github.ts
COPY src/adapters/github/runner-app-tokens.ts ./src/adapters/github/runner-app-tokens.ts
COPY src/adapters/github/archive-path.ts ./src/adapters/github/archive-path.ts
COPY src/adapters/repo-map/github.ts ./src/adapters/repo-map/github.ts
COPY src/adapters/repo-map/head-commit.ts ./src/adapters/repo-map/head-commit.ts
COPY src/adapters/repo-map/tarball.ts ./src/adapters/repo-map/tarball.ts
COPY src/adapters/repo-map/typescript.ts ./src/adapters/repo-map/typescript.ts
COPY src/adapters/repo-map/result.ts ./src/adapters/repo-map/result.ts
COPY src/adapters/repo-map/scan.ts ./src/adapters/repo-map/scan.ts
COPY src/agent-images/shared/result.ts ./src/agent-images/shared/result.ts
COPY src/agent-images/shared/job-kit.ts ./src/agent-images/shared/job-kit.ts
COPY src/agent-images/repo-map/main.ts ./src/agent-images/repo-map/main.ts
COPY src/agent-images/repo-map/image.ts ./src/agent-images/repo-map/image.ts

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/repo-map/main.ts"]
