export const dockerfile = (name: string) => `# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.3.9

FROM oven/bun:${'$'}{BUN_VERSION} AS builder
WORKDIR /workspace
ENV HUSKY=0

COPY bun.lock package.json tsconfig.base.json tsconfig.json turbo.json ./
COPY services ./services
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN bun install --frozen-lockfile
RUN bun run --filter @proompteng/${name} build

FROM oven/bun:${'$'}{BUN_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /workspace/services/${name}/.output ./.output

EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
`

export const dockerCompose = (opts: { name: string; enablePostgres?: boolean; enableRedis?: boolean }) => {
  const services: string[] = []

  if (opts.enablePostgres) {
    services.push(`  db:
    image: postgres:16
    container_name: ${opts.name}-db
    environment:
      POSTGRES_USER: ${opts.name}
      POSTGRES_PASSWORD: ${opts.name}
      POSTGRES_DB: ${opts.name}
    ports:
      - "5432:5432"
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${opts.name}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped`)
  }

  if (opts.enableRedis) {
    services.push(`  redis:
    image: redis:7-alpine
    container_name: ${opts.name}-redis
    command: redis-server --appendonly yes
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped`)
  }

  if (services.length === 0) {
    return undefined
  }

  return `version: "3.9"

services:
${services.join('\n\n')}

volumes:
  db_data:
    driver: local
`
}

export const scriptsBuild = (name: string) => `#!/usr/bin/env bun
import { resolve } from 'node:path'
import { buildAndPushDockerImage } from '../shared/docker'
import { execGit } from '../shared/git'
import { repoRoot } from '../shared/cli'

const registry = process.env.IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = process.env.IMAGE_REPOSITORY ?? 'lab/${name}'
const tag = process.env.IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
const context = resolve(repoRoot, '.')
const dockerfile = resolve(repoRoot, 'services/${name}/Dockerfile')

await buildAndPushDockerImage({
  registry,
  repository,
  tag,
  context,
  dockerfile,
  platforms: ['linux/arm64'],
})

console.log('Built and pushed ' + registry + '/' + repository + ':' + tag)
`

export const scriptsDeploy = (name: string) => `#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const registry = process.env.IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = process.env.IMAGE_REPOSITORY ?? 'lab/${name}'
const tag = process.env.IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])

const image = registry + '/' + repository + ':' + tag
const digest = (() => {
  try {
    return inspectImageDigest(image)
  } catch (error) {
    console.warn('Could not resolve digest, continuing with tag only', error)
    return undefined
  }
})()

const kustomizePath = resolve(repoRoot, 'argocd/applications/${name}/overlays/cluster/kustomization.yaml')
let kustomization = readFileSync(kustomizePath, 'utf8')
kustomization = kustomization.replace(/newTag: .*/g, 'newTag: ' + tag)
if (digest) {
  if (kustomization.includes('digest:')) {
    kustomization = kustomization.replace(/digest: .*/g, 'digest: ' + digest)
  } else {
    kustomization = kustomization.replace(/(newTag: .*)/g, '$1\\n    digest: ' + digest)
  }
}

writeFileSync(kustomizePath, kustomization)

await run('kubectl', ['apply', '-k', 'argocd/applications/${name}/overlays/cluster'], { cwd: repoRoot })
console.log('Updated kustomization and applied overlay for ${name}')
`
