# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.3.13

FROM oven/bun:${BUN_VERSION} AS builder
WORKDIR /workspace
ENV HUSKY=0

COPY bun.lock package.json tsconfig.base.json tsconfig.json turbo.json ./
COPY services ./services
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:sag

FROM oven/bun:${BUN_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CODEX_HOME=/home/bun/.codex
ENV CODEX_AUTH=/home/bun/.codex/auth.json

COPY --from=builder /workspace/services/sag/.output ./.output

RUN mkdir -p /home/bun/.codex && chown -R bun:bun /home/bun/.codex && bun add -g @openai/codex@latest

USER bun
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
