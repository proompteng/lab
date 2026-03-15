# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.3.10
ARG NODE_VERSION=24.11.1
ARG CODEX_VERSION=latest

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
ENV HUSKY=0

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/codex/package.json ./packages/codex/package.json
COPY services/symphony/package.json ./services/symphony/package.json

RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --ignore-scripts --filter @proompteng/symphony

FROM deps AS build
COPY packages/codex ./packages/codex
COPY services/symphony ./services/symphony

RUN bun --cwd packages/codex run build
RUN bun --cwd services/symphony run tsc

FROM oven/bun:${BUN_VERSION} AS runner
ARG NODE_VERSION
ARG CODEX_VERSION
WORKDIR /app
ENV NODE_ENV=production \
  HUSKY=0

RUN --mount=type=cache,target=/var/cache/apt \
  --mount=type=cache,target=/var/lib/apt/lists \
  set -eux; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends bash ca-certificates curl gh git jq xz-utils; \
  rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  ARCH="${TARGETARCH:-$(uname -m)}"; \
  case "$ARCH" in \
    amd64|x86_64) NODE_ARCH=x64 ;; \
    arm64|aarch64) NODE_ARCH=arm64 ;; \
    *) echo "Unsupported arch for Node.js: $ARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /tmp; \
  cp -r "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin" /usr/local/; \
  cp -r "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}/include" /usr/local/; \
  cp -r "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}/lib" /usr/local/; \
  cp -r "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}/share" /usr/local/; \
  rm -rf "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}" /tmp/node.tar.xz

RUN npm install -g "@openai/codex@${CODEX_VERSION}"

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/codex/package.json ./packages/codex/package.json
COPY services/symphony/package.json ./services/symphony/package.json

RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --omit=dev --ignore-scripts --filter @proompteng/symphony

COPY --from=build /app/packages/codex ./packages/codex
COPY --from=build /app/services/symphony ./services/symphony

WORKDIR /app/services/symphony
CMD ["bun", "src/index.ts", "./WORKFLOW.md"]
