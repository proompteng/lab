# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.5

FROM oven/bun:${BUN_VERSION} AS builder
WORKDIR /app

# Copy workspace manifests required for dependency installation
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY scripts/run-husky-install.mjs scripts/run-husky-install.mjs
COPY apps apps
COPY packages packages
COPY services services

# Install dependencies scoped to the bonjour package
RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --frozen-lockfile --ignore-scripts

# Build output for the Bonjour package (ensure root toolchain bins are on PATH)
RUN PATH="/app/node_modules/.bin:$PATH" bun run --filter @proompteng/bonjour build

FROM oven/bun:${BUN_VERSION} AS prod-deps
WORKDIR /app

COPY package.json bun.lock ./
COPY scripts/run-husky-install.mjs scripts/run-husky-install.mjs
COPY apps apps
COPY packages packages
COPY services services

RUN --mount=type=cache,target=/root/.cache/bun \
  bun install --no-save --production --frozen-lockfile --ignore-scripts --filter @proompteng/bonjour

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/packages/bonjour

# Copy application manifest and dependencies from the builder stage
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/packages/bonjour/node_modules /app/packages/bonjour/node_modules
COPY --from=builder /app/packages/bonjour/package.json /app/packages/bonjour/package.json
COPY --from=builder /app/packages/bonjour/dist /app/packages/bonjour/dist

EXPOSE 3000
CMD ["bun", "dist/server.js"]
