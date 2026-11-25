# The Claude Code agent image: Developer and Designer runs (ADR 0106 sections 4 to 6). Build from
# the repo root:
#   docker build -f src/agent-images/claude-code/Dockerfile -t agent-claude-code .
# A job, not a service: it listens on no port and has no health endpoint. It prints one result
# line and exits.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

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
# The task file's check of the trusted documentation hosts' names (ADR 0119 slice 4): one file
# with no imports.
COPY src/core/site-requests.ts ./src/core/site-requests.ts
# The task file's check of a Council discussion's chair, cast and pull-in limit (ADR 0119 slice
# 6): the discussion record's bounds and the personas, two files, the first importing only the
# second.
COPY src/core/discussion-record.ts ./src/core/discussion-record.ts
COPY src/core/personas.ts ./src/core/personas.ts
COPY src/agent-images/shared ./src/agent-images/shared
COPY src/agent-images/claude-code ./src/agent-images/claude-code

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/claude-code/main.ts"]
