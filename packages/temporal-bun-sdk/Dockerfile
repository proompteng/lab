# syntax=docker/dockerfile:1.6

FROM oven/bun:1.3.14 AS install
WORKDIR /app

COPY packages/temporal-bun-sdk/package.json package.json
COPY packages/temporal-bun-sdk/bunfig.toml bunfig.toml
COPY packages/temporal-bun-sdk/tsconfig.json tsconfig.json
COPY packages/temporal-bun-sdk/src src
COPY packages/temporal-bun-sdk/skills skills

RUN bun install --ignore-scripts
RUN bun run build

FROM oven/bun:1.3.14 AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY packages/temporal-bun-sdk/package.json package.json
COPY packages/temporal-bun-sdk/bunfig.toml bunfig.toml
RUN bun install --production --ignore-scripts

COPY --from=install /app/dist dist
COPY --from=install /app/skills skills

# Add health check for the worker
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

CMD ["bun", "run", "start:worker"]
