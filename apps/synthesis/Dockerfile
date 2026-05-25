ARG BUN_VERSION=1.3.14

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
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
COPY --parents services/*/package.json ./
COPY --parents services/agents/*/package.json ./
COPY --parents services/jangar/*/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
ENV HUSKY=0
COPY . .
RUN bun install --filter synthesis --frozen-lockfile
RUN bun run build:synthesis

FROM node:lts-alpine AS runner
WORKDIR /app/apps/synthesis

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/synthesis/.output /app/apps/synthesis/.output
COPY --from=builder --chown=nextjs:nodejs /app/apps/synthesis/public /app/apps/synthesis/public
COPY --from=builder --chown=nextjs:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/apps/synthesis/node_modules /app/apps/synthesis/node_modules

RUN test -f /app/apps/synthesis/node_modules/react/package.json

USER nextjs

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
