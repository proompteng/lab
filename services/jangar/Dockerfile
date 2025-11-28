# syntax=docker/dockerfile:1.6
# Bun + Node image for jangar worker + UI + Codex app-server
ARG NODE_VERSION=24.11.1
ARG BUN_VERSION=1.3.3

FROM node:${NODE_VERSION}-bookworm AS base
ARG BUN_VERSION
ENV BUN_INSTALL=/root/.bun
ENV PATH="$BUN_INSTALL/bin:$PATH"
WORKDIR /app

ENV CODEX_CWD=/app/github.com/lab \
  CODEX_REPO_SLUG=proompteng/lab \
  CODEX_REPO_URL=https://github.com/proompteng/lab.git \
  CODEX_BOOTSTRAP_REPO=1

# Tooling needed for builds and gh CLI auth
RUN set -eux; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    gnupg; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends gh; \
  rm -rf /var/lib/apt/lists/*

# Install Bun alongside Node
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

# Base tsconfig for workspace packages
COPY tsconfig.base.json ./

ENV NODE_ENV=production

# Build codex dependency (file: workspace)
COPY packages/codex ./packages/codex
RUN cd packages/codex \
  && bun add -d typescript@5.9.3 \
  && bun install --frozen-lockfile \
  && bun run build

# Install jangar deps (with dev deps for UI build)
WORKDIR /app/services/jangar
COPY services/jangar/package.json ./
COPY services/jangar/tsconfig.json ./
COPY services/jangar/src ./src
COPY bun.lock ../bun.lock
RUN mkdir -p /root/.codex
COPY services/jangar/.codex /root/.codex
RUN bun install --frozen-lockfile

# Build TanStack Start UI
RUN bun run start:build

# Prune to production deps (retain codex file dep)
RUN rm -rf node_modules \
  && bun install --frozen-lockfile --production \
  && mkdir -p node_modules/@proompteng \
  && ln -sf ../../packages/codex node_modules/@proompteng/codex

# Install Codex CLI so the app-server binary is available at runtime
RUN npm install -g @openai/codex@latest

# Authenticate gh during build (requires BuildKit secret github_token with workflow scope)
RUN --mount=type=secret,id=github_token,target=/tmp/gh_token \
  set -eux; \
  gh auth login --with-token < /tmp/gh_token; \
  gh auth status -t | grep -q "workflow" || (echo "GitHub token is missing workflow scope" >&2; exit 1); \
  gh auth setup-git

RUN git config --global user.name "tuslagch" \
  && git config --global user.email "tuslagch@proompteng.ai"

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKER_PORT=8070

CMD ["bun", "run", "src/index.ts"]
