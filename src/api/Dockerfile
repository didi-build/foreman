# The state API container (ADR 0102, ADR 0111). Build from the repo root:
#   docker build -f src/api/Dockerfile -t state-api .
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies only (pg). Scripts are skipped: the dev tooling's hooks are not installed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/service-kit ./src/service-kit
COPY src/core ./src/core
COPY src/adapters/store-postgres ./src/adapters/store-postgres
COPY src/adapters/bundle-files/files.ts ./src/adapters/bundle-files/files.ts
COPY src/adapters/windmill/client.ts ./src/adapters/windmill/client.ts
COPY src/adapters/windmill/plan-approval-flow.ts ./src/adapters/windmill/plan-approval-flow.ts
COPY src/api ./src/api

USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/api/main.ts"]
