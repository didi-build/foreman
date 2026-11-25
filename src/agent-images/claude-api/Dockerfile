# The Messages API agent image: QA, Council and Triage runs (ADR 0106, 0107, 0112), and the browser
# pod of QA's review, which runs browser-host.ts from this same image (ADR 0119 slice 5b, D-476).
# Build from the repo root:
#   docker build -f src/agent-images/claude-api/Dockerfile -t agent-claude-api .
# A job, not a service: it listens on no port and has no health endpoint. It prints one result
# line and exits. (The browser pod is started with its own command and listens on its pod's own
# address for its agent pod only.)
# No coding agent, no git and no shell tools are added: QA reads its tree through a read-only
# file tool only.
# Base image pinned by digest. Dependabot keeps the version and digest current.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

ENV NODE_ENV=production

# Chromium's headless shell for QA's browser (ADR 0119 slice 5b), at the revision playwright-core's
# browsers.json names for the exact version package.json pins: revision 1255, Chrome for Testing
# 159.0.8154.6 (test/agent-image-dockerfiles.test.ts holds the two together). Installed as root,
# read-only, where playwright-core looks for it (PLAYWRIGHT_BROWSERS_PATH). The archive comes from
# Chrome for Testing's own bucket, the build Playwright's CDN mirrors under
# builds/cft/159.0.8154.6/linux64/; the build fails unless it is the file whose SHA-256 was taken
# on 2026-11-24 (its size, 131,851,262 bytes, and MD5 matched the bucket's own record). Playwright's
# CDN was not reachable from the build sandbox, so the two hosts' bytes were not compared.
# The system libraries are the ones the headless shell links (`readelf -d`), by the names
# Playwright's own Debian 12 list gives them, plus one font family and fontconfig; curl and unzip
# are removed once the archive is unpacked. A version bump changes the revision, the URL and the
# hash together.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdbus-1-3 \
    libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libnspr4 libnss3 libudev1 libx11-6 \
    libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 \
    --output /tmp/chrome-headless-shell-linux64.zip \
    https://storage.googleapis.com/chrome-for-testing-public/159.0.8154.6/linux64/chrome-headless-shell-linux64.zip \
  && echo "77a6442fd3c8acd3bef9e1067fc26f5ef464277d22f0e8cb58dc3e4077a3e458  /tmp/chrome-headless-shell-linux64.zip" | sha256sum -c - \
  && mkdir -p /opt/ms-playwright/chromium_headless_shell-1255 \
  && unzip -q /tmp/chrome-headless-shell-linux64.zip -d /opt/ms-playwright/chromium_headless_shell-1255 \
  && touch /opt/ms-playwright/chromium_headless_shell-1255/INSTALLATION_COMPLETE \
  && rm /tmp/chrome-headless-shell-linux64.zip \
  && chmod -R a-w /opt/ms-playwright \
  && apt-get purge -y --auto-remove curl unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Runtime dependencies only (@anthropic-ai/sdk for the loop, playwright-core for the browser
# host). Scripts are skipped.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/service-kit ./src/service-kit
COPY src/adapters/agent-runtime/kubernetes/task.ts ./src/adapters/agent-runtime/kubernetes/task.ts
# The check of the bugs a run reports outside its item (D-244): one file with no imports.
COPY src/core/out-of-scope-findings.ts ./src/core/out-of-scope-findings.ts
# The check of the documentation sites a run asks to add, and of the trusted hosts' names
# (ADR 0119 slice 4): one file with no imports.
COPY src/core/site-requests.ts ./src/core/site-requests.ts
# A Council discussion (ADR 0119 slice 6): its record's bounds, which the task file's check and the
# discussion both read, and the personas it names. Two files, the first importing only the second.
COPY src/core/discussion-record.ts ./src/core/discussion-record.ts
COPY src/core/personas.ts ./src/core/personas.ts
# The browser host's site (ADR 0119 slice 5b): the runner's own zip reader with its path check,
# and CI's static server for the built site, reused as they are.
COPY src/adapters/screenshots/zip.ts ./src/adapters/screenshots/zip.ts
COPY src/core/archive-path.ts ./src/core/archive-path.ts
COPY .github/scripts/serve-site.mjs ./.github/scripts/serve-site.mjs
COPY src/agent-images/shared ./src/agent-images/shared
COPY src/agent-images/claude-api ./src/agent-images/claude-api

# The node user (1000), the runAsUser the Kubernetes runtime sets.
USER node
CMD ["node", "src/agent-images/claude-api/main.ts"]
