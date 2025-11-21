# syntax=docker/dockerfile:1.7

FROM node:24.11.1-bullseye-slim AS builder
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
RUN corepack enable
WORKDIR /workspace

# Copy workspace manifests required for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY tsconfig.json ./
COPY scripts/run-husky-install.mjs scripts/run-husky-install.mjs
COPY packages/bonjour/package.json packages/bonjour/package.json
COPY packages/bonjour/tsconfig.json packages/bonjour/tsconfig.json

# Install dependencies scoped to the bonjour package
RUN pnpm install --frozen-lockfile --filter @proompteng/bonjour...

# Copy source files and build outputs
COPY packages/bonjour packages/bonjour
RUN pnpm --filter @proompteng/bonjour build

FROM node:24.11.1-bullseye-slim AS prod-deps
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/run-husky-install.mjs scripts/run-husky-install.mjs
COPY packages/bonjour/package.json packages/bonjour/package.json

RUN pnpm install --prod --frozen-lockfile --filter @proompteng/bonjour...

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
