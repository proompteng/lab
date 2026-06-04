# syntax=docker/dockerfile:1.7
# This Dockerfile is intended to be built from a Turbo-pruned context:
# `bunx turbo prune --scope=@proompteng/oirat --docker --out-dir <dir>`
ARG BUN_VERSION=1.3.14
ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps
WORKDIR /app
COPY json/ .
COPY tsconfig.base.json ./
# Turbo prune keeps the root workspace list; drop entries that don't exist in the pruned context.
RUN bun -e "const fs = require('fs'); const p = 'package.json'; const pkg = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(pkg.workspaces)) { pkg.workspaces = pkg.workspaces.filter((entry) => entry !== 'services/jangar/*' && entry !== 'services/jangar/agentctl'); fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n'); }"
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --frozen-lockfile --ignore-scripts --filter @proompteng/discord --filter @proompteng/oirat

FROM deps AS build
COPY full/ .
RUN bun --cwd=packages/discord run build

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps-prod
WORKDIR /app
COPY json/ .
COPY tsconfig.base.json ./
RUN bun -e "const fs = require('fs'); const p = 'package.json'; const pkg = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(pkg.workspaces)) { pkg.workspaces = pkg.workspaces.filter((entry) => entry !== 'services/jangar/*' && entry !== 'services/jangar/agentctl'); fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n'); }"
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --production --frozen-lockfile --ignore-scripts --filter @proompteng/discord --filter @proompteng/oirat

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=build /app/services/oirat ./services/oirat
COPY --from=build /app/packages/discord/package.json ./packages/discord/package.json
COPY --from=build /app/packages/discord/dist ./packages/discord/dist
COPY --from=deps-prod /app/packages/discord/node_modules ./packages/discord/node_modules
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
CMD ["bun", "services/oirat/src/index.ts"]
