# The OpenCode agent image: Developer and Designer runs (D-222, D-223; ADR 0106 sections 4 to 6).
# The Claude Code image (../claude-code/) stays buildable as the fallback. Build from the repo root:
#   docker build -f src/agent-images/opencode/Dockerfile -t agent-opencode .
# A job, not a service: it listens on no port and has no health endpoint. It prints one result
# line and exits.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.4-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

ENV NODE_ENV=production

# git for the Developer's clone, commits and push through the egress proxy. Debian's package
# from the pinned base image's release.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The OpenCode CLI at an exact version, from its own lockfile (cli/package-lock.json). Only the
# image has it, never the repo's dependencies. Scripts are skipped: the package's postinstall only
# copies the platform binary over a stub, and the binary is already in its platform package
# (docs/spikes/opencode-runtime.md, Install). The binary is checked against the sha256 the spike
# recorded, copied out read-only, and the packages are removed. A version bump changes the hash
# and reruns the spike's checks.
COPY src/agent-images/opencode/cli/package.json src/agent-images/opencode/cli/package-lock.json /opt/opencode/
RUN npm ci --prefix /opt/opencode --omit=dev --ignore-scripts \
  && echo "7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c  /opt/opencode/node_modules/opencode-linux-x64/bin/opencode" | sha256sum -c - \
  && install -D -m 0555 /opt/opencode/node_modules/opencode-linux-x64/bin/opencode /opt/opencode/bin/opencode \
  && rm -rf /opt/opencode/node_modules \
  && npm cache clean --force
# Called by this path, with no shell (D-172).
ENV FOREMAN_OPENCODE_CLI=/opt/opencode/bin/opencode

# OpenCode's config home, read-only. It must already hold opencode/.gitignore (only its presence
# matters): otherwise OpenCode stops at start on a read-only folder, and with a writable one it
# installs a plugin package from the npm registry at every run (docs/spikes/opencode-runtime.md,
# check 6).
RUN mkdir -p /opt/opencode/xdg-config/opencode \
  && printf 'node_modules\n' > /opt/opencode/xdg-config/opencode/.gitignore \
  && chmod -R a-w /opt/opencode/xdg-config
ENV FOREMAN_OPENCODE_CONFIG_HOME=/opt/opencode/xdg-config

WORKDIR /app
# Only what the entrypoint runs. No node_modules: it uses Node built-ins only.
# package.json tells Node the .ts files are ES modules.
COPY package.json ./
COPY src/service-kit ./src/service-kit
COPY src/adapters/agent-runtime/kubernetes/task.ts ./src/adapters/agent-runtime/kubernetes/task.ts
COPY src/agent-images/shared ./src/agent-images/shared
COPY src/agent-images/opencode ./src/agent-images/opencode

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/opencode/main.ts"]
