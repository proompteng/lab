# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.20.0
ARG BUN_VERSION=1.1.34

FROM node:${NODE_VERSION}-bookworm AS deps
ARG BUN_VERSION
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
ENV HUSKY=0
ENV CI=true
RUN corepack enable \
  && curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY .npmrc* ./
COPY apps/froussard/package.json apps/froussard/tsconfig.json apps/froussard/tsdown.config.ts ./apps/froussard/
RUN pnpm install --filter froussard --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY apps/froussard ./apps/froussard
RUN pnpm --filter froussard run build

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY apps/froussard/package.json ./package.json
COPY bun.lock ./bun.lock
COPY --from=build /workspace/apps/froussard/dist ./dist
RUN bun install --production --frozen-lockfile
EXPOSE 8080
CMD ["bun", "dist/index.mjs"]
