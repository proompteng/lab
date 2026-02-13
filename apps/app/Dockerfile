ARG BUN_VERSION=1.3.9

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
# Root workspaces include `services/jangar/*`, so include nested workspace manifests too.
COPY --parents services/jangar/*/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
ENV HUSKY=0
COPY . .
RUN bun install --filter app --frozen-lockfile
RUN bun run build:app

FROM node:lts-alpine AS runner
WORKDIR /app/apps/app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/app/.output /app/apps/app/.output
COPY --from=builder --chown=nextjs:nodejs /app/apps/app/public /app/apps/app/public

USER nextjs

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
