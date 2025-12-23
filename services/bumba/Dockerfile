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
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=deps /app/services/bumba ./services/bumba
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
CMD ["bun", "services/bumba/src/worker.ts"]
