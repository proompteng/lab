# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.11.1
ARG BUN_VERSION=1.3.9

FROM node:${NODE_VERSION}-bookworm AS base
ARG BUN_VERSION
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
ENV HUSKY=0
ENV CI=true
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}
WORKDIR /workspace

FROM base AS deps
COPY package.json bun.lock tsconfig.base.json ./
COPY .npmrc* ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN bun install --filter @proompteng/discord --filter froussard --frozen-lockfile --ignore-scripts

FROM deps AS build
RUN bun run --filter @proompteng/discord build
RUN bun run --filter froussard build

FROM deps AS prod-deps
RUN bun install --filter froussard --production --frozen-lockfile --ignore-scripts

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=prod-deps /workspace /workspace
COPY --from=build /workspace/apps/froussard/dist /workspace/apps/froussard/dist
WORKDIR /workspace/apps/froussard
EXPOSE 8080
CMD ["bun", "dist/index.mjs"]
