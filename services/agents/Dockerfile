# syntax=docker/dockerfile:1.6
# Agents control-plane image.
#
# This is intentionally separate from the domain services so the Agents release
# owns its build graph. The control-plane and controller targets both run
# @proompteng/agents entrypoints.
ARG BUN_VERSION=1.3.14
ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun
ARG NODE24_VERSION=24.11.1
ARG KUBECTL_VERSION=1.34.3
ARG NATSCLI_VERSION=v0.4.0
ARG UV_VERSION=0.11.14
ARG GIT_VERSION=2.51.2
ARG GIT_SHA256=233d7143a2d58e60755eee9b76f559ec73ea2b3c297f5b503162ace95966b4e3

FROM --platform=$BUILDPLATFORM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS agents-build-tools
ARG BUILDARCH
ARG NODE24_VERSION
WORKDIR /app

ENV BUN_INSTALL_CACHE_DIR=/root/.bun/install/cache

RUN --mount=type=cache,sharing=locked,target=/var/cache/apt \
  --mount=type=cache,sharing=locked,target=/var/lib/apt/lists \
  set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  git \
  python3 \
  xz-utils; \
  rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  ARCH="${BUILDARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) NODE_ARCH=x64 ;; \
  arm64|aarch64) NODE_ARCH=arm64 ;; \
  ppc64le) NODE_ARCH=ppc64le ;; \
  s390x) NODE_ARCH=s390x ;; \
  *) NODE_ARCH="$ARCH" ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://nodejs.org/dist/v${NODE24_VERSION}/node-v${NODE24_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /tmp; \
  rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/bin /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/include /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/lib /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/share /usr/local/; \
  rm -rf /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH} /tmp/node.tar.xz; \
  node --version

COPY tsconfig.base.json ./

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS agents-tools
ARG NODE24_VERSION
ARG KUBECTL_VERSION
ARG NATSCLI_VERSION
WORKDIR /app

ENV BUN_INSTALL_CACHE_DIR=/root/.bun/install/cache

RUN --mount=type=cache,sharing=locked,target=/var/cache/apt \
  --mount=type=cache,sharing=locked,target=/var/lib/apt/lists \
  set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
  bash \
  build-essential \
  ca-certificates \
  curl \
  gh \
  git \
  jq \
  python3 \
  ripgrep \
  unzip \
  xz-utils \
  yq; \
  rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) NODE_ARCH=x64 ;; \
  arm64|aarch64) NODE_ARCH=arm64 ;; \
  ppc64le) NODE_ARCH=ppc64le ;; \
  s390x) NODE_ARCH=s390x ;; \
  *) NODE_ARCH="$ARCH" ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://nodejs.org/dist/v${NODE24_VERSION}/node-v${NODE24_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /tmp; \
  rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/bin /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/include /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/lib /usr/local/; \
  cp -r /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH}/share /usr/local/; \
  rm -rf /tmp/node-v${NODE24_VERSION}-linux-${NODE_ARCH} /tmp/node.tar.xz; \
  node --version

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
  ln -sf /usr/local/bin/kubectl /usr/local/bin/k; \
  rm kubectl kubectl.sha256

RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
  amd64|x86_64) NATS_ARCH=amd64 ;; \
  arm64|aarch64) NATS_ARCH=arm64 ;; \
  *) echo "Unsupported arch for nats cli: $ARCH" >&2; exit 1 ;; \
  esac; \
  NATS_VERSION="${NATSCLI_VERSION#v}"; \
  NATS_ARCHIVE="/tmp/nats-${NATS_VERSION}-linux-${NATS_ARCH}.zip"; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://github.com/nats-io/natscli/releases/download/${NATSCLI_VERSION}/nats-${NATS_VERSION}-linux-${NATS_ARCH}.zip" \
    -o "${NATS_ARCHIVE}"; \
  unzip -q "${NATS_ARCHIVE}" -d /tmp; \
  install -o root -g root -m 0755 "/tmp/nats-${NATS_VERSION}-linux-${NATS_ARCH}/nats" /usr/local/bin/nats; \
  rm -rf "${NATS_ARCHIVE}" "/tmp/nats-${NATS_VERSION}-linux-${NATS_ARCH}"; \
  nats --version

FROM agents-build-tools AS agents-workspace-deps
WORKDIR /app
ENV NODE_ENV=development
COPY json/ .
RUN --mount=type=cache,id=bun-install-cache-agents-workspace-deps,target=/root/.bun/install/cache \
  bun install --no-save --ignore-scripts --linker=hoisted \
    --filter @proompteng/agents \
    --filter @proompteng/codex \
    --filter @proompteng/otel \
    --filter @proompteng/temporal-bun-sdk \
    --filter @proompteng/cx-tools

FROM agents-workspace-deps AS codex-build
WORKDIR /app
COPY full/packages/codex ./packages/codex
RUN bun --cwd=packages/codex run build

FROM agents-workspace-deps AS agent-contracts-build
WORKDIR /app
COPY full/packages/agent-contracts ./packages/agent-contracts
RUN bun --cwd=packages/agent-contracts run build

FROM agents-workspace-deps AS otel-build
WORKDIR /app
COPY full/packages/otel ./packages/otel
RUN bun --cwd=packages/otel run build

FROM agents-workspace-deps AS temporal-bun-sdk-build
WORKDIR /app
COPY full/packages/otel ./packages/otel
COPY full/packages/temporal-bun-sdk ./packages/temporal-bun-sdk
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
RUN bun --cwd=packages/temporal-bun-sdk run build

FROM agents-workspace-deps AS cx-tools-build
WORKDIR /app
COPY full/packages/cx-tools ./packages/cx-tools
RUN bun --cwd=packages/cx-tools run build

FROM agents-workspace-deps AS agents-build
WORKDIR /app
ENV NODE_ENV=production
RUN rm -rf /app/packages /app/services
COPY full/ .
COPY --from=agent-contracts-build /app/packages/agent-contracts /app/packages/agent-contracts
COPY --from=codex-build /app/packages/codex/dist /app/packages/codex/dist
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/dist /app/packages/temporal-bun-sdk/dist
WORKDIR /app/services/agents
ARG AGENTS_BUILD_NODE_OPTIONS="--max-old-space-size=2048"
ARG AGENTS_BUILD_CI=false
ENV NODE_OPTIONS=${AGENTS_BUILD_NODE_OPTIONS}
ENV CI=${AGENTS_BUILD_CI}
RUN bun run tsc
RUN bun run build

FROM agents-tools AS agents-deps-prod
WORKDIR /app
ENV NODE_ENV=production
COPY json/ .
RUN --mount=type=cache,id=bun-install-cache-agents-deps-prod,target=/root/.bun/install/cache \
  bun install --no-save --ignore-scripts --linker=hoisted --filter @proompteng/agents \
  && rm -rf /app/node_modules/node-pty/prebuilds

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS control-plane
ARG AGENTS_VERSION=""
ARG AGENTS_COMMIT=""

COPY --from=agents-tools /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=agents-tools /usr/local/bin/k /usr/local/bin/k
COPY --from=agents-tools /usr/local/bin/nats /usr/local/bin/nats

WORKDIR /app
COPY --from=codex-build /app/packages/codex/package.json /app/packages/codex/package.json
COPY --from=codex-build /app/packages/codex/dist /app/packages/codex/dist
COPY --from=agent-contracts-build /app/packages/agent-contracts /app/packages/agent-contracts
COPY --from=otel-build /app/packages/otel/package.json /app/packages/otel/package.json
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/package.json /app/packages/temporal-bun-sdk/package.json
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/dist /app/packages/temporal-bun-sdk/dist
COPY --from=cx-tools-build /app/packages/cx-tools/package.json /app/packages/cx-tools/package.json
COPY --from=cx-tools-build /app/packages/cx-tools/dist /app/packages/cx-tools/dist
RUN ln -sf /app/packages/cx-tools/dist/cx-codex-run.js /usr/local/bin/cx-codex-run \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-start.js /usr/local/bin/cx-workflow-start \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-cancel.js /usr/local/bin/cx-workflow-cancel \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-query.js /usr/local/bin/cx-workflow-query \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-signal.js /usr/local/bin/cx-workflow-signal \
  && ln -sf /app/packages/cx-tools/dist/codex-nats-publish.js /usr/local/bin/codex-nats-publish \
  && ln -sf /app/packages/cx-tools/dist/codex-nats-soak.js /usr/local/bin/codex-nats-soak \
  && chmod +x /app/packages/cx-tools/dist/*.js

COPY --from=agents-deps-prod /app/node_modules ./node_modules
RUN mkdir -p /app/packages/agent-contracts/node_modules \
  && ln -sf /app/node_modules/effect /app/packages/agent-contracts/node_modules/effect
WORKDIR /app/services/agents
COPY --from=agents-build /app/services/agents/package.json ./package.json
COPY --from=agents-build /app/services/agents/.output ./.output
COPY --from=agents-build /app/services/agents/src ./src
COPY --from=agents-build /app/services/agents/scripts ./scripts

RUN bun -e "await import('@proompteng/agent-contracts')"

ENV AGENTS_CONTROLLER_ENABLED=0 \
  AGENTS_ORCHESTRATION_CONTROLLER_ENABLED=0 \
  AGENTS_SUPPORTING_CONTROLLER_ENABLED=0 \
  AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED=true \
  AGENTS_PRIMITIVES_RECONCILER=0 \
  AGENTS_SERVER_PROFILE=agents-control-plane \
  AGENTS_RUNTIME_SERVICE=agents
ENV AGENTS_VERSION=${AGENTS_VERSION} \
  AGENTS_COMMIT=${AGENTS_COMMIT}

CMD ["bun", "run", "start"]

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS controller
ARG AGENTS_VERSION=""
ARG AGENTS_COMMIT=""

COPY --from=agents-tools /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=agents-tools /usr/local/bin/k /usr/local/bin/k
COPY --from=agents-tools /usr/local/bin/nats /usr/local/bin/nats

WORKDIR /app
COPY --from=codex-build /app/packages/codex/package.json /app/packages/codex/package.json
COPY --from=codex-build /app/packages/codex/dist /app/packages/codex/dist
COPY --from=agent-contracts-build /app/packages/agent-contracts /app/packages/agent-contracts
COPY --from=otel-build /app/packages/otel/package.json /app/packages/otel/package.json
COPY --from=otel-build /app/packages/otel/dist /app/packages/otel/dist
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/package.json /app/packages/temporal-bun-sdk/package.json
COPY --from=temporal-bun-sdk-build /app/packages/temporal-bun-sdk/dist /app/packages/temporal-bun-sdk/dist
COPY --from=cx-tools-build /app/packages/cx-tools/package.json /app/packages/cx-tools/package.json
COPY --from=cx-tools-build /app/packages/cx-tools/dist /app/packages/cx-tools/dist
RUN ln -sf /app/packages/cx-tools/dist/cx-codex-run.js /usr/local/bin/cx-codex-run \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-start.js /usr/local/bin/cx-workflow-start \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-cancel.js /usr/local/bin/cx-workflow-cancel \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-query.js /usr/local/bin/cx-workflow-query \
  && ln -sf /app/packages/cx-tools/dist/cx-workflow-signal.js /usr/local/bin/cx-workflow-signal \
  && ln -sf /app/packages/cx-tools/dist/codex-nats-publish.js /usr/local/bin/codex-nats-publish \
  && ln -sf /app/packages/cx-tools/dist/codex-nats-soak.js /usr/local/bin/codex-nats-soak \
  && chmod +x /app/packages/cx-tools/dist/*.js

COPY --from=agents-deps-prod /app/node_modules ./node_modules
RUN mkdir -p /app/packages/agent-contracts/node_modules \
  && ln -sf /app/node_modules/effect /app/packages/agent-contracts/node_modules/effect
WORKDIR /app/services/agents
COPY --from=agents-build /app/services/agents/package.json ./package.json
COPY --from=agents-build /app/services/agents/src ./src
COPY --from=agents-build /app/services/agents/scripts ./scripts

RUN bun -e "await import('@proompteng/agent-contracts')"

ENV AGENTS_SERVER_PROFILE=agents-controllers \
  AGENTS_CONTROL_PLANE_CACHE_ENABLED=0 \
  AGENTS_GRPC_ENABLED=0 \
  AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED=true \
  AGENTS_RUNTIME_SERVICE=agents
ENV AGENTS_VERSION=${AGENTS_VERSION} \
  AGENTS_COMMIT=${AGENTS_COMMIT}

CMD ["bun", "run", "src/server/controller-entrypoint.ts"]

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS patched-git-build
ARG GIT_VERSION
ARG GIT_SHA256

RUN --mount=type=cache,sharing=locked,target=/var/cache/apt \
  --mount=type=cache,sharing=locked,target=/var/lib/apt/lists \
  set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  libcurl4-gnutls-dev \
  libexpat1-dev \
  libssl-dev \
  python3 \
  xz-utils \
  zlib1g-dev; \
  rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://www.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" \
    -o /tmp/git.tar.xz; \
  printf '%s  %s\n' "${GIT_SHA256}" /tmp/git.tar.xz | sha256sum -c -; \
  mkdir -p /tmp/git-source; \
  tar -xJf /tmp/git.tar.xz -C /tmp/git-source --strip-components=1; \
  cd /tmp/git-source; \
  python3 -c 'from pathlib import Path; p=Path("setup.c"); s=p.read_text(); old="void sanitize_stdfds(void)\n{\n\tint fd = xopen(\"/dev/null\", O_RDWR);\n\twhile (fd < 2)\n\t\tfd = xdup(fd);\n\tif (fd > 2)\n\t\tclose(fd);\n}\n"; new="void sanitize_stdfds(void)\n{\n\tint fd;\n\n\tfor (fd = 0; fd <= 2; fd++) {\n\t\tif (fcntl(fd, F_GETFD) < 0) {\n\t\t\tif (errno == EBADF)\n\t\t\t\tbreak;\n\t\t\tdie_errno(_(\"could not inspect standard file descriptor %d\"), fd);\n\t\t}\n\t}\n\tif (fd > 2)\n\t\treturn;\n\n\tfd = xopen(\"/dev/null\", O_RDWR);\n\twhile (fd < 2)\n\t\tfd = xdup(fd);\n\tif (fd > 2)\n\t\tclose(fd);\n}\n"; old in s or (_ for _ in ()).throw(SystemExit("Git sanitize_stdfds implementation changed")); p.write_text(s.replace(old, new, 1))'
RUN set -eux; \
  cd /tmp/git-source; \
  make -j"$(nproc)" \
    prefix=/usr/local \
    NO_GETTEXT=YesPlease \
    NO_INSTALL_HARDLINKS=YesPlease \
    NO_PERL=YesPlease \
    NO_PYTHON=YesPlease \
    NO_TCLTK=YesPlease; \
  make \
    prefix=/usr/local \
    DESTDIR=/opt/agents-shell-git \
    NO_GETTEXT=YesPlease \
    NO_INSTALL_HARDLINKS=YesPlease \
    NO_PERL=YesPlease \
    NO_PYTHON=YesPlease \
    NO_TCLTK=YesPlease \
    install; \
  test -x /opt/agents-shell-git/usr/local/bin/git; \
  rm -rf /tmp/git-source /tmp/git.tar.xz

FROM controller AS agents-shell
ARG UV_VERSION
ARG GIT_VERSION

RUN --mount=type=cache,sharing=locked,target=/var/cache/apt \
  --mount=type=cache,sharing=locked,target=/var/lib/apt/lists \
  set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends \
  bash \
  build-essential \
  ca-certificates \
  curl \
  gh \
  git \
  jq \
  openssh-client \
  procps \
  python3-dev \
  python3-pip \
  python3-venv \
  python3 \
  ripgrep \
  wget \
  yq; \
  ln -sf /usr/bin/python3 /usr/local/bin/python; \
  rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir "uv==${UV_VERSION}" \
  && uv --version

COPY --from=patched-git-build /opt/agents-shell-git/usr/local/bin/ /usr/local/bin/
COPY --from=patched-git-build /opt/agents-shell-git/usr/local/libexec/git-core/ /usr/local/libexec/git-core/
COPY --from=patched-git-build /opt/agents-shell-git/usr/local/share/git-core/ /usr/local/share/git-core/

WORKDIR /app/services/agents
RUN install -o root -g root -m 0755 ./scripts/apply_patch.py /usr/local/bin/apply_patch \
  && cc -O2 -Wall -Wextra -Werror -o /usr/local/bin/agents-shell-landlock ./src/server/agents-shell/native/landlock-exec.c \
  && strip /usr/local/bin/agents-shell-landlock \
  && chmod +x ./scripts/agents-shell-entrypoint.sh \
  && mkdir -p /workspace /workspace/.agents-shell \
  && command -v bash git gh rg curl jq yq python3 uv ps wget kubectl apply_patch agents-shell-landlock \
  && test "$(command -v git)" = /usr/local/bin/git \
  && git --version | grep -F "git version ${GIT_VERSION}" \
  && agents-shell-landlock --check \
  && tmp="$(mktemp -d)" \
  && cd "$tmp" \
  && printf '%s\n' old > smoke.txt \
  && printf '%s\n' \
    '*** Begin Patch' \
    '*** Update File: smoke.txt' \
    '@@' \
    '-old' \
    '+new' \
    '*** End Patch' \
    | apply_patch \
  && grep -qx new smoke.txt \
  && rm -rf "$tmp"

ENV AGENTS_SERVER_PROFILE=agents-shell \
  AGENTS_GRPC_ENABLED=0 \
  AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED=true \
  AGENTS_RUNTIME_SERVICE=agents-shell \
  AGENTS_SHELL_WORKSPACE_ROOT=/workspace \
  AGENTS_SHELL_WORKSPACE_SEED_PATH=/workspace/lab \
  AGENTS_SHELL_WORKSPACE_LEASE_ROOT=/workspace/worktrees/lab \
  AGENTS_SHELL_SESSION_RUNTIME_ROOT=/workspace/.agents-shell/sessions \
  AGENTS_SHELL_LEASE_STATE_PATH=/workspace/.agents-shell/leases.json \
  AGENTS_SHELL_AUDIT_LOG_PATH=/workspace/.agents-shell/audit.jsonl \
  AGENTS_SHELL_LANDLOCK_EXECUTABLE=/usr/local/bin/agents-shell-landlock \
  AGENTS_SHELL_RESOURCE=https://agents-shell.proompteng.ai \
  AGENTS_SHELL_OAUTH_ISSUER=https://auth.proompteng.ai/realms/master \
  AGENTS_SHELL_ALLOWED_K8S_NAMESPACES=agents

CMD ["./scripts/agents-shell-entrypoint.sh"]
