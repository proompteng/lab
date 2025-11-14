# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.20.0
ARG BUN_VERSION=1.1.34

FROM node:${NODE_VERSION}-bookworm AS base
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

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY .npmrc* ./
COPY scripts ./scripts
COPY apps/froussard ./apps/froussard
COPY packages/discord ./packages/discord
RUN pnpm install --filter @proompteng/discord --filter froussard --frozen-lockfile --ignore-scripts

FROM deps AS build
RUN pnpm --filter @proompteng/discord run build
RUN pnpm --filter froussard run build

FROM deps AS prod-deps
RUN pnpm install --filter froussard --prod --frozen-lockfile --ignore-scripts

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=prod-deps /workspace /workspace
COPY --from=build /workspace/apps/froussard/dist /workspace/apps/froussard/dist
WORKDIR /workspace/apps/froussard
EXPOSE 8080
CMD ["bun", "dist/index.mjs"]
