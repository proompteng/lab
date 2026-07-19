# syntax=docker/dockerfile:1.7

ARG BUN_IMAGE=mirror.gcr.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --production --frozen-lockfile --ignore-scripts --filter @proompteng/bayn

FROM ${BUN_IMAGE} AS runner
WORKDIR /app/services/bayn
ENV NODE_ENV=production \
  BAYN_HOST=0.0.0.0 \
  BAYN_PORT=8080
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/services/bayn/node_modules /app/services/bayn/node_modules
COPY --from=dependencies /app/services/bayn/package.json /app/services/bayn/package.json
COPY --from=dependencies /app/services/bayn/src /app/services/bayn/src
USER bun
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const port = process.env.BAYN_PORT ?? '8080'; const response = await fetch(`http://127.0.0.1:${port}/livez`); if (!response.ok) process.exit(1)"]
CMD ["bun", "src/main.ts"]
