ARG BUN_VERSION=1.3.5

FROM node:lts-alpine AS deps
ARG BUN_VERSION
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
ENV HUSKY=0
WORKDIR /app
RUN apk add --no-cache bash curl
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

COPY package.json bun.lock .npmrc* tsconfig.base.json ./
COPY scripts/run-husky-install.mjs ./scripts/run-husky-install.mjs
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
ENV HUSKY=0
COPY . .
RUN bun install --filter @proompteng/backend --frozen-lockfile --ignore-scripts
RUN bun run build:proompteng

FROM node:lts-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/proompteng/.next/standalone /app
COPY --from=builder --chown=nextjs:nodejs /app/apps/proompteng/.next/static /app/apps/proompteng/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/proompteng/public /app/apps/proompteng/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

WORKDIR /app/apps/proompteng
CMD ["node", "server.js"]
