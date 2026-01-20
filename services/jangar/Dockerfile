# syntax=docker/dockerfile:1.6
# Bun image for jangar worker + UI + Codex app-server
#
# NOTE: This Dockerfile is intended to be built from a Turbo-pruned context produced by:
#   `bunx turbo prune --scope=@proompteng/jangar --docker --out-dir <dir>`
#
# Expected build context layout:
# - `json/` contains the pruned `package.json` + workspace package.jsons + `bun.lock`
# - `full/` contains the full pruned source tree
# - `tsconfig.base.json` is copied into the context root by the build script
# - `skills/` is present at the context root for Codex CLI skills
ARG BUN_VERSION=1.3.5
ARG OPENVSCODE_VERSION=1.106.3
ARG GH_VERSION=2.83.2
ARG ZOXIDE_VERSION=0.9.8
ARG KUBECTL_VERSION=1.34.3
ARG KN_VERSION=1.20.0
ARG CNPG_VERSION=1.28.0
ARG NEOVIM_VERSION=stable
ARG DOCKER_CLI_VERSION=29.1.2
ARG BUILDX_VERSION=0.30.1
ARG GO_VERSION=1.25.5
ARG TEMURIN25_JDK_TAG=jdk-25.0.1+8
ARG TEMURIN25_JDK_VERSION=25.0.1_8
ARG GRADLE_VERSION=9.2.1

FROM oven/bun:${BUN_VERSION} AS tools
ARG NODE24_VERSION=24.11.1
ARG OPENVSCODE_VERSION
ARG GH_VERSION
ARG ZOXIDE_VERSION
ARG KUBECTL_VERSION
ARG KN_VERSION
ARG CNPG_VERSION
ARG NEOVIM_VERSION
ARG DOCKER_CLI_VERSION
ARG BUILDX_VERSION
ARG GO_VERSION
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
  jq \
  ripgrep \
  tmux \
  tini \
  unzip; \
  rm -rf /var/lib/apt/lists/*

# Basic tmux defaults for web terminals.
RUN set -eux; \
  cat <<'TMUX' > /etc/tmux.conf
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g mouse on
set -g history-limit 50000
TMUX

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

# Install Go toolchain
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) GO_ARCH=amd64 ;; \
  arm64|aarch64) GO_ARCH=arm64 ;; \
  *) echo "Unsupported arch for Go: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    -o /tmp/go.tgz; \
  rm -rf /usr/local/go; \
  tar -xzf /tmp/go.tgz -C /usr/local; \
  rm -f /tmp/go.tgz; \
  /usr/local/go/bin/go version

ENV GOROOT=/usr/local/go
ENV PATH="${GOROOT}/bin:${PATH}"

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

# Make Java/Gradle discoverable even in login shells that overwrite PATH (e.g. VS Code terminal).
RUN set -eux; \
  ln -sf /opt/java/current/bin/java /usr/local/bin/java; \
  if [ -x /opt/java/current/bin/javac ]; then ln -sf /opt/java/current/bin/javac /usr/local/bin/javac; fi; \
  ln -sf /opt/gradle/current/bin/gradle /usr/local/bin/gradle; \
  ln -sf /usr/local/go/bin/go /usr/local/bin/go; \
  cat <<'PROFILE' > /etc/profile.d/jangar-java-gradle.sh
export JAVA_HOME=/opt/java/current
export GRADLE_HOME=/opt/gradle/current
export GOROOT=/usr/local/go
case ":$PATH:" in
  *":/opt/java/current/bin:"*) ;;
  *) PATH="/opt/java/current/bin:$PATH" ;;
esac
case ":$PATH:" in
  *":/opt/gradle/current/bin:"*) ;;
  *) PATH="/opt/gradle/current/bin:$PATH" ;;
esac
case ":$PATH:" in
  *":/usr/local/go/bin:"*) ;;
  *) PATH="/usr/local/go/bin:$PATH" ;;
esac
export PATH
PROFILE

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

# Install zoxide (official installer script)
RUN set -eux; \
  curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | \
    sh -s -- --bin-dir /usr/local/bin --man-dir /usr/local/share/man; \
  zoxide --version; \
  cat <<'PROFILE' > /etc/profile.d/zoxide.sh
if command -v zoxide >/dev/null 2>&1; then
  if [ -z "${__ZOXIDE_INIT_DONE-}" ]; then
    __ZOXIDE_INIT_DONE=1
    export __ZOXIDE_INIT_DONE
    case "${SHELL-}" in
      */zsh) eval "$(zoxide init zsh)" ;;
      *) eval "$(zoxide init bash)" ;;
    esac
  fi
fi
PROFILE

# Ensure interactive bash shells load zoxide (for `z` alias).
RUN set -eux; \
  if [ -f /etc/bash.bashrc ]; then \
    printf '\n# zoxide\nif [ -f /etc/profile.d/zoxide.sh ]; then\n  . /etc/profile.d/zoxide.sh\nfi\n' >> /etc/bash.bashrc; \
  fi

# Install Neovim (official releases) + AstroNvim configuration (template)
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) NVIM_ARCH=linux64 ;; \
  arm64|aarch64) NVIM_ARCH=linux-arm64 ;; \
  *) echo "Unsupported arch for neovim: $ARCH" >&2; exit 1 ;; \
  esac; \
  NVIM_URL="https://github.com/neovim/neovim/releases/download/${NEOVIM_VERSION}/nvim-${NVIM_ARCH}.tar.gz"; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "$NVIM_URL" -o /tmp/nvim.tar.gz; \
  rm -rf /opt/nvim; \
  mkdir -p /opt/nvim; \
  tar -xzf /tmp/nvim.tar.gz -C /opt/nvim --strip-components=1; \
  rm -f /tmp/nvim.tar.gz; \
  ln -sf /opt/nvim/bin/nvim /usr/local/bin/nvim; \
  ln -sf /opt/nvim/bin/nvim /usr/local/bin/vim; \
  nvim --version | head -n 1; \
  if [ -d /root/.config/nvim ]; then mv /root/.config/nvim /root/.config/nvim.bak; fi; \
  if [ -d /root/.local/share/nvim ]; then mv /root/.local/share/nvim /root/.local/share/nvim.bak; fi; \
  if [ -d /root/.local/state/nvim ]; then mv /root/.local/state/nvim /root/.local/state/nvim.bak; fi; \
  if [ -d /root/.cache/nvim ]; then mv /root/.cache/nvim /root/.cache/nvim.bak; fi; \
  mkdir -p /root/.config; \
  git clone --depth 1 https://github.com/AstroNvim/template /root/.config/nvim; \
  rm -rf /root/.config/nvim/.git; \
  nvim --headless +q

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
  if ! grep -Eq '^[0-9a-f]{64}$' kubectl.sha256; then \
  echo "kubectl.sha256 has unexpected contents:" >&2; \
  cat kubectl.sha256 >&2; \
  exit 1; \
  fi; \
  printf '%s  %s\n' "$(cat kubectl.sha256)" kubectl | sha256sum -c -; \
  install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl; \
  rm kubectl kubectl.sha256; \
  kubectl version --client --output=yaml

# Install Knative CLI (kn)
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) KN_ARCH=amd64 ;; \
  arm64|aarch64) KN_ARCH=arm64 ;; \
  *) echo "Unsupported arch for kn: $ARCH" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  KN_TAG="knative-v${KN_VERSION}"; \
  ASSET="kn-linux-${KN_ARCH}"; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "https://github.com/knative/client/releases/download/${KN_TAG}/${ASSET}" -o "${ASSET}"; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "https://github.com/knative/client/releases/download/${KN_TAG}/checksums.txt" -o checksums.txt; \
  EXPECTED_SHA="$(grep -E "^[0-9a-f]{64}  ${ASSET}$" checksums.txt | awk '{print $1}')"; \
  if [ -z "${EXPECTED_SHA}" ]; then \
    echo "Failed to find checksum entry for ${ASSET} in checksums.txt" >&2; \
    head -n 50 checksums.txt >&2; \
    exit 1; \
  fi; \
  printf '%s  %s\n' "${EXPECTED_SHA}" "${ASSET}" | sha256sum -c -; \
  install -o root -g root -m 0755 "${ASSET}" /usr/local/bin/kn; \
  rm -f "${ASSET}" checksums.txt; \
  kn version


# Install CloudNativePG kubectl plugin (`kubectl cnpg ...`)
RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) CNPG_ARCH=linux_x86_64 ;; \
  arm64|aarch64) CNPG_ARCH=linux_arm64 ;; \
  *) echo "Unsupported arch for kubectl-cnpg: $ARCH" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  TARBALL="kubectl-cnpg_${CNPG_VERSION}_${CNPG_ARCH}.tar.gz"; \
  CHECKSUMS="cnpg-${CNPG_VERSION}-checksums.txt"; \
  BASE_URL="https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_VERSION}"; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "${BASE_URL}/${TARBALL}" -o "${TARBALL}"; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "${BASE_URL}/${CHECKSUMS}" -o "${CHECKSUMS}"; \
  EXPECTED_SHA="$(grep -E "^[0-9a-f]{64}  ${TARBALL}$" "${CHECKSUMS}" | awk '{print $1}')"; \
  if [ -z "${EXPECTED_SHA}" ]; then \
    echo "Failed to find checksum entry for ${TARBALL} in ${CHECKSUMS}" >&2; \
    head -n 50 "${CHECKSUMS}" >&2; \
    exit 1; \
  fi; \
  printf '%s  %s\n' "${EXPECTED_SHA}" "${TARBALL}" | sha256sum -c -; \
  tar -xzf "${TARBALL}" -C /tmp; \
  install -o root -g root -m 0755 /tmp/kubectl-cnpg /usr/local/bin/kubectl-cnpg; \
  rm -f "${TARBALL}" "${CHECKSUMS}" /tmp/kubectl-cnpg; \
  command -v kubectl-cnpg >/dev/null

# Make `k` available for kubectl (VS Code terminals often prefer `k`).
RUN set -eux; \
  ln -sf /usr/local/bin/kubectl /usr/local/bin/k; \
  cat <<'PROFILE' > /etc/profile.d/jangar-kubectl.sh
alias k=kubectl
PROFILE

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

# Install docker buildx
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
RUN --mount=type=cache,target=/root/.cache/bun bun add -g @openai/codex@latest

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
WORKDIR /app
COPY json/ .
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/codex
COPY full/ .
RUN bun --cwd=packages/codex run build

FROM tools AS otel-build
WORKDIR /app
COPY json/ .
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/otel
COPY full/ .
RUN bun --cwd=packages/otel run build

FROM tools AS temporal-bun-sdk-build
WORKDIR /app
COPY json/ .
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/temporal-bun-sdk
COPY full/ .
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
RUN bun --cwd=packages/temporal-bun-sdk run build

FROM tools AS tools-pty
RUN --mount=type=cache,target=/var/cache/apt \
  --mount=type=cache,target=/var/lib/apt/lists \
  set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends python3; \
  rm -rf /var/lib/apt/lists/*

FROM tools-pty AS jangar-pty
ARG TARGETARCH
WORKDIR /app
COPY json/ .
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/jangar
RUN --mount=type=cache,target=/root/.cache/bun \
  set -eux; \
  case "${TARGETARCH:-$(uname -m)}" in \
    amd64|x86_64) NODE_ARCH=x64 ;; \
    arm64|aarch64) NODE_ARCH=arm64 ;; \
    *) NODE_ARCH="${TARGETARCH:-$(uname -m)}" ;; \
  esac; \
  NODE_PTY_DIR="$(node -p "require.resolve('node-pty/package.json')" 2>/dev/null || (cd /app/services/jangar && node -p "require.resolve('node-pty/package.json')"))"; \
  NODE_PTY_DIR="$(dirname "$NODE_PTY_DIR")"; \
  cd "$NODE_PTY_DIR"; \
  export PYTHON=python3; \
  npm_config_build_from_source=true \
  npm_config_nodedir=/usr/local \
  npm_config_arch="$NODE_ARCH" \
  npm_config_target="$(node -p 'process.versions.node')" \
  bunx node-gyp rebuild; \
  mkdir -p /tmp/node-pty/prebuilds; \
  cp -R "$NODE_PTY_DIR/build" /tmp/node-pty/build; \
  if [ -d "$NODE_PTY_DIR/prebuilds" ]; then cp -R "$NODE_PTY_DIR/prebuilds"/* /tmp/node-pty/prebuilds/; fi

FROM tools AS jangar-deps-dev
WORKDIR /app
COPY json/ .
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/jangar

FROM jangar-deps-dev AS jangar-build
WORKDIR /app
COPY full/ .
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/dist /app/packages/temporal-bun-sdk/dist
WORKDIR /app/services/jangar
ARG JANGAR_BUILD_NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_OPTIONS=${JANGAR_BUILD_NODE_OPTIONS}
RUN bun run start:build

FROM tools AS jangar-deps-prod
WORKDIR /app
COPY json/ .
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --ignore-scripts --filter @proompteng/jangar

FROM tools AS runtime

ENV PATH="/usr/local/go/bin:${PATH}"

COPY --from=codex-build /app/packages/codex/package.json /app/packages/codex/package.json
COPY --from=codex-build /app/packages/codex/dist /app/packages/codex/dist
COPY --from=otel-build /app/packages/otel/package.json /app/packages/otel/package.json
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/package.json /app/packages/temporal-bun-sdk/package.json
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/dist /app/packages/temporal-bun-sdk/dist

WORKDIR /app
COPY --from=jangar-deps-prod /app/node_modules ./node_modules
COPY --from=jangar-pty /tmp/node-pty/build /app/node_modules/node-pty/build
COPY --from=jangar-pty /tmp/node-pty/prebuilds /app/node_modules/node-pty/prebuilds

WORKDIR /app/services/jangar
COPY --from=jangar-build /app/services/jangar/.output ./.output
COPY --from=jangar-build /app/services/jangar/package.json ./package.json
COPY --from=jangar-pty /tmp/node-pty/build /app/services/jangar/.output/server/node_modules/node-pty/build
COPY --from=jangar-pty /tmp/node-pty/prebuilds /app/services/jangar/.output/server/node_modules/node-pty/prebuilds

RUN mkdir -p /root/.codex
RUN --mount=type=secret,id=codexauth,target=/tmp/codex_auth.json \
  install -m 600 /tmp/codex_auth.json /root/.codex/auth.json
COPY --from=jangar-build /app/services/jangar/scripts/codex-config-container.toml /root/.codex/config.toml
COPY --from=jangar-build /app/services/jangar/scripts/agent-runner.ts /usr/local/bin/agent-runner
COPY --from=jangar-build /app/services/jangar/scripts/codex-implement.ts /usr/local/bin/codex-implement
COPY --from=jangar-build /app/services/jangar/scripts/agent-providers /etc/agent-providers
COPY skills/ /root/.codex/skills/
RUN chmod +x /usr/local/bin/agent-runner /usr/local/bin/codex-implement

# Start the compiled Nitro server produced by `bun --bun vite build`
CMD ["bun", "run", ".output/server/index.mjs"]
