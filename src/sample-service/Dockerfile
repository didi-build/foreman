# Reference container for ADR 0111. Build from the repo root:
#   docker build -f src/sample-service/Dockerfile -t sample-service .
# node:22.22.0-slim, pinned by digest.
FROM node:22.22.0-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

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
