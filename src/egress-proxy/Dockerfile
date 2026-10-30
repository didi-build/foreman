# The per-run egress proxy container (ADR 0106 section 2, ADR 0111). Build from the repo root:
#   docker build -f src/egress-proxy/Dockerfile -t egress-proxy .
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.3-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

ENV NODE_ENV=production
WORKDIR /app

# Only what the service runs. No node_modules: the proxy uses Node built-ins only.
# package.json tells Node the .ts files are ES modules.
COPY package.json ./
COPY src/service-kit ./src/service-kit
COPY src/egress-proxy ./src/egress-proxy

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/egress-proxy/main.ts"]
