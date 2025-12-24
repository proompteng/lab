# syntax=docker/dockerfile:1.7
# This Dockerfile is intended to be built from a Turbo-pruned context:
# `bunx turbo prune --scope=@proompteng/bumba --docker --out-dir <dir>`
ARG BUN_VERSION=1.3.5

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
ENV HUSKY=0
COPY json/ .
COPY tsconfig.base.json ./
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --frozen-lockfile --ignore-scripts --filter @proompteng/bumba

FROM deps AS build
COPY full/ .
RUN bun --cwd=packages/temporal-bun-sdk run build

FROM oven/bun:${BUN_VERSION} AS deps-prod
WORKDIR /app
ENV HUSKY=0
COPY json/ .
COPY tsconfig.base.json ./
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --production --frozen-lockfile --ignore-scripts --filter @proompteng/bumba

FROM oven/bun:${BUN_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN --mount=type=cache,target=/var/cache/apt \
  --mount=type=cache,target=/var/lib/apt/lists \
  set -eux; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends git ca-certificates; \
  rm -rf /var/lib/apt/lists/*
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=build /app/services/bumba ./services/bumba
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/packages/temporal-bun-sdk ./packages/temporal-bun-sdk
CMD ["bun", "services/bumba/src/worker.ts"]
