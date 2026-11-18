# Reference container for ADR 0111. Build from the repo root:
#   docker build -f src/sample-service/Dockerfile -t sample-service .
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

ENV NODE_ENV=production
WORKDIR /app

# Only what the service runs. No node_modules: the service kit uses Node built-ins only.
# package.json tells Node the .ts files are ES modules.
COPY package.json ./
COPY src/service-kit ./src/service-kit
COPY src/sample-service ./src/sample-service

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/sample-service/main.ts"]
