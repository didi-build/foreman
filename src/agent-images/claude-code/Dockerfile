# The Claude Code agent image: Developer and Designer runs (ADR 0106 sections 4 to 6). Build from
# the repo root:
#   docker build -f src/agent-images/claude-code/Dockerfile -t agent-claude-code .
# A job, not a service: it listens on no port and has no health endpoint. It prints one result
# line and exits.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.3-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

ENV NODE_ENV=production

# git for the Developer's clone, commits and push through the egress proxy. Debian's package
# from the pinned base image's release.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI at an exact version, from its own lockfile (cli/package-lock.json). Only
# the image has it, never the repo's dependencies. Its install script copies the native binary
# for this platform over bin/claude.exe, so scripts are allowed for this one install.
COPY src/agent-images/claude-code/cli/package.json src/agent-images/claude-code/cli/package-lock.json /opt/claude-code/
RUN npm ci --prefix /opt/claude-code --omit=dev && npm cache clean --force
# Called by this path, with no shell (D-172).
ENV FOREMAN_CLAUDE_CLI=/opt/claude-code/node_modules/@anthropic-ai/claude-code/bin/claude.exe

WORKDIR /app
# Only what the entrypoint runs. No node_modules: it uses Node built-ins only.
# package.json tells Node the .ts files are ES modules.
COPY package.json ./
COPY src/service-kit ./src/service-kit
COPY src/adapters/agent-runtime/kubernetes/task.ts ./src/adapters/agent-runtime/kubernetes/task.ts
COPY src/agent-images/shared ./src/agent-images/shared
COPY src/agent-images/claude-code ./src/agent-images/claude-code

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/claude-code/main.ts"]
