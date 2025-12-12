# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.4

FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

ENV NODE_ENV=production

COPY bun.lock ./bun.lock

COPY packages/discord ./packages/discord
COPY services/discord-bot ./services/discord-bot

WORKDIR /app/services/discord-bot
RUN --mount=type=cache,target=/root/.cache/bun bun install --frozen-lockfile --production

CMD ["bun", "run", "start"]
