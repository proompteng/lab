# syntax=docker/dockerfile:1.6
# Built from a Turbo-pruned context produced by:
#   bunx turbo prune --scope=reestr --docker --out-dir <dir>

FROM oven/bun:1.3.5 AS deps
WORKDIR /app
COPY json/ ./
COPY tsconfig.base.json ./tsconfig.base.json

ENV HUSKY=0
ENV SKIP_HUSKY=1
RUN bun install --no-save --ignore-scripts --filter reestr

FROM deps AS builder
WORKDIR /app
COPY full/ ./
WORKDIR /app/apps/reestr
RUN bun run build

FROM oven/bun:1.3.5 AS runner
WORKDIR /app/apps/reestr
ENV NODE_ENV=production
ENV PORT=4173

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/reestr/.output ./.output
COPY --from=builder /app/apps/reestr/package.json ./package.json

EXPOSE 4173
CMD ["bun", ".output/server/index.mjs"]
