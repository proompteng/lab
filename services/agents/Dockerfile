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
  build-essential \
  ca-certificates \
  curl \
  git \
  python3 \
  unzip \
  xz-utils; \
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

COPY tsconfig.base.json ./

FROM agents-tools AS agents-workspace-deps
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
