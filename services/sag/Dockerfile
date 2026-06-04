# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION} AS builder
WORKDIR /workspace

COPY bun.lock package.json tsconfig.base.json tsconfig.json turbo.json ./
COPY services ./services
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:sag

FROM node:24.11.1-bookworm-slim AS node-runtime

FROM oven/bun:${BUN_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CODEX_HOME=/home/bun/.codex
ENV CODEX_AUTH=/home/bun/.codex/auth.json
ENV BUN_INSTALL=/home/bun/.bun
ENV PATH=/home/bun/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/services/sag/.output ./.output
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

RUN mkdir -p /home/bun/.bun /home/bun/.codex \
  && bun add -g @openai/codex@latest \
  && chown -R bun:bun /home/bun/.bun /home/bun/.codex

USER bun
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
