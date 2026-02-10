ARG BUN_VERSION=1.3.5

FROM node:lts-alpine AS deps
ARG BUN_VERSION
WORKDIR /app

ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN apk add --no-cache bash curl python3 make g++
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

COPY package.json bun.lock .npmrc* turbo.json tsconfig.base.json tsconfig.json ./
COPY scripts/run-husky-install.mjs ./scripts/run-husky-install.mjs
COPY apps ./apps
COPY packages ./packages
COPY services ./services

ENV HUSKY=0
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app

COPY . .

RUN bun run --filter docs build

FROM node:lts-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/docs/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/docs/public ./apps/docs/public

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

WORKDIR /app/apps/docs
CMD ["node", "server.js"]
