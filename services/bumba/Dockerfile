# syntax=docker/dockerfile:1.7
# This Dockerfile is intended to be built from a Turbo-pruned context:
# `bunx turbo prune --scope=@proompteng/bumba --docker --out-dir <dir>`
ARG BUN_VERSION=1.3.9
ARG LAB_GIT_SHA=dev

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
ENV HUSKY=0
COPY json/ .
COPY tsconfig.base.json ./
# Turbo prune leaves the root workspace list intact; drop missing explicit entries.
RUN bun -e "const fs = require('fs'); const path = 'package.json'; const pkg = JSON.parse(fs.readFileSync(path, 'utf8')); if (Array.isArray(pkg.workspaces)) { pkg.workspaces = pkg.workspaces.filter((entry) => entry !== 'services/jangar/agentctl'); fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\\n'); }"
# Turbo prune doesn't emit a bun.lock that stays frozen with trimmed workspaces.
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --ignore-scripts --filter @proompteng/bumba

FROM deps AS build
COPY full/ .
RUN bun --cwd=packages/otel run build
RUN bun --cwd=packages/temporal-bun-sdk run build

FROM oven/bun:${BUN_VERSION} AS deps-prod
WORKDIR /app
ENV HUSKY=0
COPY json/ .
COPY tsconfig.base.json ./
RUN bun -e "const fs = require('fs'); const path = 'package.json'; const pkg = JSON.parse(fs.readFileSync(path, 'utf8')); if (Array.isArray(pkg.workspaces)) { pkg.workspaces = pkg.workspaces.filter((entry) => entry !== 'services/jangar/agentctl'); fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\\n'); }"
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --omit=dev --ignore-scripts --filter @proompteng/bumba

FROM oven/bun:${BUN_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG LAB_GIT_SHA=dev
ENV TEMPORAL_WORKER_BUILD_ID=bumba@${LAB_GIT_SHA}
RUN --mount=type=cache,target=/var/cache/apt \
  --mount=type=cache,target=/var/lib/apt/lists \
  set -eux; \
  apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20; \
  apt-get install -y --no-install-recommends git ca-certificates; \
  rm -rf /var/lib/apt/lists/*
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=build /app/services/bumba ./services/bumba
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/packages/otel ./packages/otel
COPY --from=build /app/packages/temporal-bun-sdk ./packages/temporal-bun-sdk
CMD ["bun", "services/bumba/src/worker.ts"]
