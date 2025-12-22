# Builder
FROM oven/bun:1.3.5 AS builder
WORKDIR /app

COPY bun.lock package.json tsconfig.base.json tsconfig.json turbo.json biome.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

ENV HUSKY=0
ENV SKIP_HUSKY=1
RUN bun install --frozen-lockfile --ignore-scripts

WORKDIR /app/apps/reestr
RUN bun run build

# Runtime (bun)
FROM oven/bun:1.3.5 AS runner
WORKDIR /app/apps/reestr
ENV NODE_ENV=production
ENV PORT=4173

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/reestr/dist ./dist
COPY --from=builder /app/apps/reestr/package.json ./package.json

EXPOSE 4173
CMD ["bun", "dist/server/server.js"]
