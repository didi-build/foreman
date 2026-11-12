# QA's fetch step's image (ADR 0106 section 5, ADR 0112, D-184, O-124). Build from the repo root:
#   docker build -f src/agent-images/qa-fetch/Dockerfile -t qa-fetch .
# A job, not a service: it listens on nothing and has no health endpoint. It downloads the archive
# of one commit through its egress proxy with QA's read-only token, checks it is that commit,
# unpacks it read-only into the run's volume (no link, device or path outside the volume), scans
# it for the token, prints one result line and exits.
# No coding agent, no git, no shell tools, no model SDK and no npm packages: only Node and its
# built-ins.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NODE_ENV=production
# Node's fetch goes through HTTPS_PROXY, the Job's egress proxy, only with this set.
ENV NODE_USE_ENV_PROXY=1
WORKDIR /app

# Only the files the Job runs. No node_modules: built-ins only.
# package.json tells Node the .ts files are ES modules.
COPY package.json ./
COPY src/service-kit/config.ts ./src/service-kit/config.ts
COPY src/core/github.ts ./src/core/github.ts
COPY src/adapters/github/archive-path.ts ./src/adapters/github/archive-path.ts
COPY src/adapters/github/runner-app-tokens.ts ./src/adapters/github/runner-app-tokens.ts
# The secret-value scan's forms of a value (ADR 0106 section 5): one file with no imports.
COPY scripts/lib/find-secret-values.mjs ./scripts/lib/find-secret-values.mjs
COPY src/agent-images/shared/result.ts ./src/agent-images/shared/result.ts
COPY src/agent-images/shared/job-kit.ts ./src/agent-images/shared/job-kit.ts
COPY src/agent-images/qa-fetch/main.ts ./src/agent-images/qa-fetch/main.ts
COPY src/agent-images/qa-fetch/image.ts ./src/agent-images/qa-fetch/image.ts
COPY src/agent-images/qa-fetch/unpack.ts ./src/agent-images/qa-fetch/unpack.ts

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/qa-fetch/main.ts"]
