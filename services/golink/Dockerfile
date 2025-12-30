# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.3.5

FROM oven/bun:${BUN_VERSION} AS builder
WORKDIR /workspace
ENV HUSKY=0

COPY bun.lock package.json tsconfig.base.json tsconfig.json turbo.json ./
COPY services ./services
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:golink

FROM oven/bun:${BUN_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /workspace/services/golink/.output ./.output
COPY --from=builder /workspace/services/golink/src/db/migrations ./src/db/migrations

EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
