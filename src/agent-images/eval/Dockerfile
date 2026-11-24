# The weekly test job's image (ADR 0117, D-432). Build from the repo root:
#   docker build -f src/agent-images/eval/Dockerfile -t foreman-eval .
# A job, not a service: it listens on no port and has no health endpoint. It runs every planned
# case of the weekly model test set on every planned model through its egress proxy, scores each
# answer with the runner's own checks, prints one result line and exits.
# No coding agent, no git and no shell tools: Node, the Anthropic SDK (the Messages API loop), the
# TypeScript compiler (Triage's repo map, parsed, never run) and the YAML parser (the cases, the
# bot files and the persona files). It holds no credential: the proxy adds each provider's key.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

ENV NODE_ENV=production
WORKDIR /app

# The three packages at the root's exact versions, from the image's own lockfile (deps/), which
# also tells Node the .ts files are ES modules. Install scripts are skipped.
COPY src/agent-images/eval/deps/package.json src/agent-images/eval/deps/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The data the job reads: the cases with their trees, and the bot files with the persona files
# their runs' instructions are composed with (ADR 0119 slice 2), as the runner reads them.
COPY eval/cases ./eval/cases
COPY contracts/bots ./contracts/bots
COPY contracts/personas ./contracts/personas

# The core whole: the runner's builders and checks reach most of its files through each other.
COPY src/core ./src/core
COPY src/eval ./src/eval
COPY src/service-kit/config.ts ./src/service-kit/config.ts
COPY src/service-kit/logger.ts ./src/service-kit/logger.ts
COPY src/adapters/agent-runtime/kubernetes/task.ts ./src/adapters/agent-runtime/kubernetes/task.ts
COPY src/adapters/agent-runtime/kubernetes/manifests.ts ./src/adapters/agent-runtime/kubernetes/manifests.ts
COPY src/adapters/agent-runtime/kubernetes/names.ts ./src/adapters/agent-runtime/kubernetes/names.ts
COPY src/adapters/bundle-files/files.ts ./src/adapters/bundle-files/files.ts
COPY src/adapters/contracts-file/bot-files.ts ./src/adapters/contracts-file/bot-files.ts
COPY src/adapters/contracts-file/personas.ts ./src/adapters/contracts-file/personas.ts
COPY src/adapters/repo-map/typescript.ts ./src/adapters/repo-map/typescript.ts
COPY src/egress-proxy/hosts.ts ./src/egress-proxy/hosts.ts
COPY src/egress-proxy/lookup.ts ./src/egress-proxy/lookup.ts
COPY src/egress-proxy/providers.ts ./src/egress-proxy/providers.ts
COPY src/egress-proxy/state-api.ts ./src/egress-proxy/state-api.ts
COPY src/agent-images/opencode/permissions.ts ./src/agent-images/opencode/permissions.ts
COPY src/agent-images/shared ./src/agent-images/shared
COPY src/agent-images/claude-api/image.ts ./src/agent-images/claude-api/image.ts
COPY src/agent-images/claude-api/loop.ts ./src/agent-images/claude-api/loop.ts
COPY src/agent-images/claude-api/files.ts ./src/agent-images/claude-api/files.ts
COPY src/agent-images/claude-api/prompts.ts ./src/agent-images/claude-api/prompts.ts
COPY src/agent-images/claude-api/verdict.ts ./src/agent-images/claude-api/verdict.ts
COPY src/agent-images/eval/main.ts ./src/agent-images/eval/main.ts
COPY src/agent-images/eval/image.ts ./src/agent-images/eval/image.ts
COPY src/agent-images/eval/plan.ts ./src/agent-images/eval/plan.ts
COPY src/agent-images/eval/result.ts ./src/agent-images/eval/result.ts
COPY src/agent-images/eval/week.ts ./src/agent-images/eval/week.ts

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/eval/main.ts"]
