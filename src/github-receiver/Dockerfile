# The GitHub webhook receiver container (ADR 0113, ADR 0111). Build from the repo root:
#   docker build -f src/github-receiver/Dockerfile -t github-receiver .
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies only (the receiver uses pg). Scripts are skipped: the dev
# tooling's hooks are not installed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/service-kit ./src/service-kit
COPY src/core ./src/core
COPY src/adapters/store-postgres ./src/adapters/store-postgres
COPY src/adapters/bundle-files/files.ts ./src/adapters/bundle-files/files.ts
COPY src/adapters/github ./src/adapters/github
COPY src/adapters/windmill/client.ts ./src/adapters/windmill/client.ts
COPY src/adapters/windmill/receiver-flows.ts ./src/adapters/windmill/receiver-flows.ts
# No contracts: the due checks the receiver ran on CI's end moved into the ingest flow with the
# GitHub reads (D-381, O-128).
COPY src/github-receiver ./src/github-receiver

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/github-receiver/main.ts"]
