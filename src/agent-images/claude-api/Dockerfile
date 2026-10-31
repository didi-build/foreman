# The Messages API agent image: QA, Council and Triage runs (ADR 0106, 0107, 0112). Build from the
# repo root:
#   docker build -f src/agent-images/claude-api/Dockerfile -t agent-claude-api .
# A job, not a service: it listens on no port and has no health endpoint. It prints one result
# line and exits.
# No coding agent, no git and no shell tools are added: QA reads its tree through a read-only
# file tool only.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.4-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies only (@anthropic-ai/sdk is the one this image uses). Scripts are skipped.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/service-kit ./src/service-kit
COPY src/adapters/agent-runtime/kubernetes/task.ts ./src/adapters/agent-runtime/kubernetes/task.ts
COPY src/agent-images/shared ./src/agent-images/shared
COPY src/agent-images/claude-api ./src/agent-images/claude-api

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/claude-api/main.ts"]
