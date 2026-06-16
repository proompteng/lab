# syntax=docker/dockerfile:1.7
# Built from a Turbo-pruned context:
# `bunx turbo prune --scope=@proompteng/anypi --docker --out-dir <dir>`
ARG BUN_VERSION=1.3.14
ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun
ARG NODE_VERSION=24.11.1
ARG UV_VERSION=0.11.14
ARG HELM_VERSION=3.18.6
ARG KUSTOMIZE_VERSION=5.8.1
ARG LAB_GIT_SHA=dev

FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY json/ .
COPY tsconfig.base.json ./
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --omit=dev --ignore-scripts --filter @proompteng/anypi

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION}-slim AS runner
ARG LAB_GIT_SHA
ARG UV_VERSION
ARG HELM_VERSION
ARG KUSTOMIZE_VERSION
ENV NODE_ENV=production \
  WORKSPACE=/workspace \
  WORKTREE=/workspace/lab \
  GIT_TERMINAL_PROMPT=0 \
  BUN_INSTALL=/usr/local \
  ANYPI_WORKSPACE=/workspace \
  ANYPI_WORKTREE=/workspace/lab \
  ANYPI_AGENT_DIR=/workspace/.anypi

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN --mount=type=cache,sharing=locked,target=/var/cache/apt \
  --mount=type=cache,sharing=locked,target=/var/lib/apt/lists \
  set -eux; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y -V --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    gh \
    git \
    jq \
    openssh-client \
    python3 \
    python3-pip; \
  rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir "uv==${UV_VERSION}"

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
    amd64) tool_arch=amd64 ;; \
    arm64) tool_arch=arm64 ;; \
    *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${tool_arch}.tar.gz" -o /tmp/helm.tar.gz; \
  tar -xzf /tmp/helm.tar.gz -C /tmp; \
  mv "/tmp/linux-${tool_arch}/helm" /usr/local/bin/helm; \
  curl -fsSL \
    "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_${tool_arch}.tar.gz" \
    -o /tmp/kustomize.tar.gz; \
  tar -xzf /tmp/kustomize.tar.gz -C /usr/local/bin kustomize; \
  rm -rf /tmp/helm.tar.gz /tmp/kustomize.tar.gz "/tmp/linux-${tool_arch}"; \
  helm version --short; \
  kustomize version

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY full/services/anypi ./services/anypi
COPY --from=deps /app/services/anypi/node_modules ./services/anypi/node_modules

RUN mkdir -p /workspace /app/services/anypi \
  && printf '%s\n' '#!/bin/sh' 'exec bun /app/services/anypi/src/main.ts "$@"' > /usr/local/bin/anypi-runner \
  && chmod +x /usr/local/bin/anypi-runner \
  && cd /app/services/anypi \
  && bun -e "await import('@earendil-works/pi-coding-agent')" \
  && test -x /usr/local/bin/anypi-runner \
  && printf '%s\n' "${LAB_GIT_SHA}" > /app/services/anypi/build-sha.txt

WORKDIR /workspace
CMD ["bash"]
