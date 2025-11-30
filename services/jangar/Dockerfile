# syntax=docker/dockerfile:1.6
# Bun image for jangar worker + UI + Codex app-server
ARG BUN_VERSION=1.3.3
ARG OPENVSCODE_VERSION=1.105.1
ARG KUBECTL_VERSION=v1.30.4
ARG DOCKER_CLI_VERSION=27.1.2

FROM oven/bun:${BUN_VERSION} AS base
ARG NODE24_VERSION=24.11.1
ARG BUILDX_VERSION
ARG OPENVSCODE_VERSION
ARG KUBECTL_VERSION
ARG DOCKER_CLI_VERSION
WORKDIR /app

ENV CODEX_CWD=/workspace/lab \
  CODEX_REPO_SLUG=proompteng/lab \
  CODEX_REPO_URL=https://github.com/proompteng/lab.git \
  CODEX_BOOTSTRAP_REPO=1

# Tooling needed for builds, gh CLI auth, and VS Code server
RUN set -eux; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    gnupg \
    ripgrep \
    tini; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
  KUBE_SERIES="${KUBECTL_VERSION%.*}"; \
  KUBE_REPO="https://pkgs.k8s.io/core:/stable:/${KUBE_SERIES}/deb"; \
  curl -fSLs --noproxy '*' "$KUBE_REPO/Release.key" | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg; \
  echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] $KUBE_REPO/ /" > /etc/apt/sources.list.d/kubernetes.list; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends gh kubectl; \
  rm -rf /var/lib/apt/lists/*

# Install Node.js, Docker CLI, and buildx plugins in a single block to avoid repeating arch detection
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
    amd64|x86_64) NODE_ARCH=x64 ;; \
    arm64|aarch64) NODE_ARCH=arm64 ;; \
    ppc64le) NODE_ARCH=ppc64le ;; \
    s390x) NODE_ARCH=s390x ;; \
    *) NODE_ARCH="$ARCH" ;; \
  esac; \
  curl -fsSL "https://nodejs.org/dist/v${NODE24_VERSION}/node-v${NODE24_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /tmp; \
  rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/bin /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/include /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/lib /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/share /usr/local/; \
  rm -rf /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH} /tmp/node.tar.xz; \
  case "$ARCH" in \
    amd64|x86_64) DOCKER_ARCH=x86_64 ;; \
    arm64|aarch64) DOCKER_ARCH=aarch64 ;; \
    *) echo "Unsupported arch for Docker CLI: $ARCH" >&2; exit 1 ;; \
  esac; \
  case "$ARCH" in \
    amd64|x86_64) BUILDx_ARCH=amd64 ;; \
    arm64|aarch64) BUILDx_ARCH=arm64 ;; \
    ppc64le) BUILDx_ARCH=ppc64le ;; \
    s390x) BUILDx_ARCH=s390x ;; \
    *) echo "Unsupported arch for Docker buildx: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fSLs -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz"; \
  tar -xz -C /usr/local/bin --strip-components=1 -f /tmp/docker.tgz docker/docker; \
  rm /tmp/docker.tgz; \
  mkdir -p /usr/libexec/docker/cli-plugins /usr/local/lib/docker/cli-plugins /usr/lib/docker/cli-plugins; \
  curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${BUILDx_ARCH}" -o /usr/libexec/docker/cli-plugins/docker-buildx; \
  chmod +x /usr/libexec/docker/cli-plugins/docker-buildx; \
  ln -sf /usr/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx; \
  ln -sf /usr/libexec/docker/cli-plugins/docker-buildx /usr/lib/docker/cli-plugins/docker-buildx

# Base tsconfig for workspace packages
COPY tsconfig.base.json ./

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

# Install Codex CLI with Bun so the app-server binary is available at runtime
RUN bun add -g @openai/codex@latest

# Install openvscode-server (upstream VS Code server build from gitpod-io)
RUN set -eux; \
  ARCH="$(uname -m)"; \
  case "$ARCH" in \
    aarch64|arm64) OVS_ARCH=arm64 ;; \
    x86_64|amd64)  OVS_ARCH=x64 ;; \
    *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fL "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-${OVS_ARCH}.tar.gz" -o /tmp/ovscode.tar.gz; \
  mkdir -p /opt/openvscode-server; \
  tar -xzf /tmp/ovscode.tar.gz -C /opt/openvscode-server --strip-components=1; \
  rm /tmp/ovscode.tar.gz; \
  ln -sf /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server

# Authenticate gh during build (requires BuildKit secret github_token with workflow scope)
RUN --mount=type=secret,id=github_token,target=/tmp/gh_token \
  set -eux; \
  gh auth login --with-token < /tmp/gh_token; \
  gh auth status -t | grep -q "workflow" || (echo "GitHub token is missing workflow scope" >&2; exit 1); \
  gh auth setup-git

RUN git config --global user.name "tuslagch" \
  && git config --global user.email "tuslagch@proompteng.ai" \
  && git config --global push.autoSetupRemote true

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKER_PORT=8070
ENV VSCODE_PORT=8081
ENV VSCODE_DATA_DIR=/workspace/.ovscode
ENV VSCODE_DEFAULT_FOLDER=/workspace/lab

# Launch openvscode-server alongside the app
RUN cat <<'ENTRY' > /usr/local/bin/entrypoint.sh \
  && chmod +x /usr/local/bin/entrypoint.sh
#!/bin/bash
set -euo pipefail
mkdir -p "$VSCODE_DATA_DIR" "$VSCODE_DEFAULT_FOLDER"
# Start OpenVSCode in background; exit container if it dies
openvscode-server \
  --host 0.0.0.0 \
  --port "$VSCODE_PORT" \
  --disable-telemetry \
  --without-connection-token \
  --user-data-dir "$VSCODE_DATA_DIR" \
  --extensions-dir "$VSCODE_DATA_DIR/extensions" \
  --default-folder "$VSCODE_DEFAULT_FOLDER" &
vscode_pid=$!
trap "kill $vscode_pid" EXIT
exec "$@"
ENTRY

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
