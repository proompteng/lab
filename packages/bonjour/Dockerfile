# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.5

FROM node:24.11.1-bullseye-slim AS builder
ARG BUN_VERSION
ENV BUN_INSTALL=/root/.bun
ENV PATH=$BUN_INSTALL/bin:$PATH
ENV HUSKY=0
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}
WORKDIR /workspace

# Copy workspace manifests required for dependency installation
COPY package.json bun.lock tsconfig.base.json ./
COPY tsconfig.json ./
COPY scripts/run-husky-install.mjs scripts/run-husky-install.mjs
COPY packages/bonjour/package.json packages/bonjour/package.json
COPY packages/bonjour/tsconfig.json packages/bonjour/tsconfig.json

# Install dependencies scoped to the bonjour package
RUN bun install --frozen-lockfile --ignore-scripts --filter @proompteng/bonjour

# Copy source files and build outputs
COPY packages/bonjour packages/bonjour
RUN bun run --filter @proompteng/bonjour build

FROM node:24.11.1-bullseye-slim AS prod-deps
ARG BUN_VERSION
ENV BUN_INSTALL=/root/.bun
ENV PATH=$BUN_INSTALL/bin:$PATH
ENV HUSKY=0
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}
WORKDIR /workspace

COPY package.json bun.lock ./
COPY scripts/run-husky-install.mjs scripts/run-husky-install.mjs
COPY packages/bonjour/package.json packages/bonjour/package.json

RUN bun install --production --frozen-lockfile --ignore-scripts --filter @proompteng/bonjour

FROM node:24.11.1-bullseye-slim AS runtime
ENV NODE_ENV=production
WORKDIR /opt/app

# Copy application manifest and dependencies from the builder stage
COPY --from=builder /workspace/packages/bonjour/package.json ./package.json
COPY --from=prod-deps /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages/bonjour/dist ./dist

# Drop root privileges for runtime
RUN chown -R node:node /opt/app
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
