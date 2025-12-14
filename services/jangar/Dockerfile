# syntax=docker/dockerfile:1.6
# Bun image for jangar worker + UI + Codex app-server
ARG BUN_VERSION=1.3.4
ARG OPENVSCODE_VERSION=1.105.1
ARG GH_VERSION=2.65.0
ARG KUBECTL_VERSION=1.34.3
ARG DOCKER_CLI_VERSION=29.1.2
ARG BUILDX_VERSION=0.30.1
ARG TEMURIN25_JDK_TAG=jdk-25.0.1+8
ARG TEMURIN25_JDK_VERSION=25.0.1_8
ARG GRADLE_VERSION=9.2.1

FROM oven/bun:${BUN_VERSION} AS tools
ARG NODE24_VERSION=24.11.1
ARG OPENVSCODE_VERSION
ARG GH_VERSION
ARG KUBECTL_VERSION
ARG DOCKER_CLI_VERSION
ARG BUILDX_VERSION
ARG TEMURIN25_JDK_TAG
ARG TEMURIN25_JDK_VERSION
ARG GRADLE_VERSION
WORKDIR /app

ENV CODEX_CWD=/workspace/lab \
  CODEX_REPO_SLUG=proompteng/lab \
  CODEX_REPO_URL=https://github.com/proompteng/lab.git \
  CODEX_BOOTSTRAP_REPO=1

# Tooling needed for builds and VS Code server
RUN --mount=type=cache,target=/var/cache/apt \
  --mount=type=cache,target=/var/lib/apt/lists \
  set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  ripgrep \
  tini \
  unzip; \
  rm -rf /var/lib/apt/lists/*

# Install Java 25 (Temurin)
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) JDK_ARCH=x64 ;; \
  arm64|aarch64) JDK_ARCH=aarch64 ;; \
  *) echo "Unsupported arch for temurin jdk: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://github.com/adoptium/temurin25-binaries/releases/download/${TEMURIN25_JDK_TAG}/OpenJDK25U-jdk_${JDK_ARCH}_linux_hotspot_${TEMURIN25_JDK_VERSION}.tar.gz" \
    -o /tmp/jdk.tgz; \
  mkdir -p /opt/java; \
  tar -xzf /tmp/jdk.tgz -C /opt/java; \
  rm -f /tmp/jdk.tgz; \
  jdk_dir="/opt/java/${TEMURIN25_JDK_TAG}"; \
  if [ ! -d "$jdk_dir" ]; then \
    jdk_dir="$(find /opt/java -maxdepth 1 -type d -name 'jdk-*' | head -n 1)"; \
  fi; \
  test -d "$jdk_dir"; \
  ln -sfn "$jdk_dir" /opt/java/current

ENV JAVA_HOME=/opt/java/current
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Install Gradle
RUN set -eux; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    -o /tmp/gradle.zip; \
  mkdir -p /opt/gradle; \
  unzip -q /tmp/gradle.zip -d /opt/gradle; \
  rm -f /tmp/gradle.zip; \
  test -d "/opt/gradle/gradle-${GRADLE_VERSION}"; \
  ln -sfn "/opt/gradle/gradle-${GRADLE_VERSION}" /opt/gradle/current

ENV GRADLE_HOME=/opt/gradle/current
ENV PATH="${GRADLE_HOME}/bin:${PATH}"

# Lightweight GitHub CLI install (no apt repo)
RUN set -eux; \
  ARCH="$(uname -m)"; \
  case "$ARCH" in \
  amd64|x86_64) GH_ARCH=amd64 ;; \
  arm64|aarch64) GH_ARCH=arm64 ;; \
  *) echo "Unsupported arch for gh: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" -o /tmp/gh.tar.gz; \
  tar -xzf /tmp/gh.tar.gz -C /tmp; \
  install /tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh /usr/local/bin/gh; \
  rm -rf /tmp/gh.tar.gz /tmp/gh_${GH_VERSION}_linux_${GH_ARCH}

# Install Node.js once for both Bun and tools that expect node
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) NODE_ARCH=x64 ;; \
  arm64|aarch64) NODE_ARCH=arm64 ;; \
  ppc64le) NODE_ARCH=ppc64le ;; \
  s390x) NODE_ARCH=s390x ;; \
  *) NODE_ARCH="$ARCH" ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "https://nodejs.org/dist/v${NODE24_VERSION}/node-v${NODE24_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /tmp; \
  rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/bin /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/include /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/lib /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/share /usr/local/; \
  rm -rf /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH} /tmp/node.tar.xz

# Install kubectl (per kubernetes.io guidance)
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) K_ARCH=amd64 ;; \
  arm64|aarch64) K_ARCH=arm64 ;; \
  *) echo "Unsupported arch for kubectl: $ARCH" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  curl -fsSLO "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${K_ARCH}/kubectl"; \
  curl -fsSLO "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${K_ARCH}/kubectl.sha256"; \
  # sanity check: ensure checksum file looks like a single SHA-256
  if ! grep -Eq '^[0-9a-f]{64}$' kubectl.sha256; then \
  echo "kubectl.sha256 has unexpected contents:" >&2; \
  cat kubectl.sha256 >&2; \
  exit 1; \
  fi; \
  printf '%s  %s\n' "$(cat kubectl.sha256)" kubectl | sha256sum -c -; \
  install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl; \
  rm kubectl kubectl.sha256; \
  kubectl version --client --output=yaml

# Install Docker CLI (client only; daemon runs in sidecar)
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) DOCKER_ARCH=x86_64 ;; \
  arm64|aarch64) DOCKER_ARCH=aarch64 ;; \
  *) echo "Unsupported arch for docker cli: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" \
    -o /tmp/docker.tgz; \
  tar -xzf /tmp/docker.tgz -C /tmp; \
  install /tmp/docker/docker /usr/local/bin/docker; \
  rm -rf /tmp/docker.tgz /tmp/docker; \
  docker --version

# Install docker buildx plugin so BuildKit secrets and multi-arch builds work in CI/runtime
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) BUILDX_ARCH=linux-amd64 ;; \
  arm64|aarch64) BUILDX_ARCH=linux-arm64 ;; \
  *) echo "Unsupported arch for buildx: $ARCH" >&2; exit 1 ;; \
  esac; \
  VERSION="${BUILDX_VERSION#v}"; \
  mkdir -p /usr/lib/docker/cli-plugins; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://github.com/docker/buildx/releases/download/v${VERSION}/buildx-v${VERSION}.${BUILDX_ARCH}" \
    -o /usr/lib/docker/cli-plugins/docker-buildx; \
  chmod +x /usr/lib/docker/cli-plugins/docker-buildx; \
  /usr/lib/docker/cli-plugins/docker-buildx version

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
  curl -fL --retry 5 --retry-delay 2 --retry-all-errors "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-${OVS_ARCH}.tar.gz" -o /tmp/ovscode.tar.gz; \
  mkdir -p /opt/openvscode-server; \
  tar -xzf /tmp/ovscode.tar.gz -C /opt/openvscode-server --strip-components=1; \
  rm /tmp/ovscode.tar.gz; \
  ln -sf /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server

# Base tsconfig for workspace packages
COPY tsconfig.base.json ./

# Authenticate gh during build (requires BuildKit secret github_token with workflow scope)
RUN --mount=type=secret,id=github_token,target=/tmp/gh_token \
  set -eux; \
  gh auth login --with-token < /tmp/gh_token; \
  gh auth status -t | grep -q "workflow" || (echo "GitHub token is missing workflow scope" >&2; exit 1); \
  gh auth setup-git

RUN git config --global user.name "gregkonush" \
  && git config --global user.email "12027037+gregkonush@users.noreply.github.com" \
  && git config --global push.autoSetupRemote true

ENV NODE_ENV=production
ENV PORT=8080
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

FROM tools AS codex-build

# Build codex dependency (workspace package)
WORKDIR /app
COPY package.json ./package.json
COPY packages/codex/package.json ./packages/codex/package.json
COPY packages/codex/tsconfig.json ./packages/codex/tsconfig.json
COPY packages/codex/src ./packages/codex/src
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/codex \
  && bun --cwd=packages/codex run build

FROM tools AS jangar-deps-dev
WORKDIR /app/services/jangar
COPY package.json /app/package.json
COPY packages/codex/package.json /app/packages/codex/package.json
COPY services/jangar/package.json ./package.json
COPY services/jangar/tsconfig.json ./tsconfig.json
RUN --mount=type=cache,target=/root/.cache/bun bun install --no-save --ignore-scripts

FROM jangar-deps-dev AS jangar-build
COPY --from=codex-build /app/packages/codex/src /app/packages/codex/src
COPY services/jangar/vite.config.ts /app/services/jangar/vite.config.ts
COPY services/jangar/vitest.config.ts /app/services/jangar/vitest.config.ts
COPY services/jangar/public /app/services/jangar/public
COPY services/jangar/src /app/services/jangar/src
RUN bun run start:build

FROM tools AS jangar-deps-prod
WORKDIR /app/services/jangar
COPY package.json /app/package.json
COPY packages/codex/package.json /app/packages/codex/package.json
COPY services/jangar/package.json ./package.json
RUN --mount=type=cache,target=/root/.cache/bun bun install --no-save --production --ignore-scripts

FROM tools AS runtime

COPY --from=codex-build /app/packages/codex/package.json /app/packages/codex/package.json
COPY --from=codex-build /app/packages/codex/dist /app/packages/codex/dist

WORKDIR /app/services/jangar
COPY --from=jangar-deps-prod /app/services/jangar/node_modules ./node_modules
COPY --from=jangar-build /app/services/jangar/.output ./.output
COPY services/jangar/package.json ./package.json

RUN mkdir -p /root/.codex
RUN --mount=type=secret,id=codexauth,target=/tmp/codex_auth.json \
  install -m 600 /tmp/codex_auth.json /root/.codex/auth.json
COPY services/jangar/scripts/codex-config-container.toml /root/.codex/config.toml

# Start the compiled Nitro server produced by `bun --bun vite build`
CMD ["bun", "run", ".output/server/index.mjs"]
