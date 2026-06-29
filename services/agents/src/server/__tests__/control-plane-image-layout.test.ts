import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const dockerfile = () => readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8')
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url))

const listProductionSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return listProductionSources(path)
    if (!path.endsWith('.ts')) return []
    if (path.endsWith('.test.ts') || path.endsWith('.spec.ts') || path.endsWith('.d.ts')) return []
    return [path]
  })

const dockerfileTarget = (target: string) => {
  const content = dockerfile()
  const start = content.indexOf(` AS ${target}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const fromStart = content.lastIndexOf('\nFROM ', start)
  const next = content.indexOf('\nFROM ', start + target.length)
  return content.slice(fromStart >= 0 ? fromStart + 1 : 0, next >= 0 ? next : undefined)
}

describe('Agents control-plane image layout', () => {
  it('builds the Agents service for the control-plane target', () => {
    const content = dockerfileTarget('control-plane')

    expect(content).toContain('WORKDIR /app/services/agents')
    expect(content).toContain('COPY --from=agents-build /app/services/agents/src ./src')
    expect(content).toContain('COPY --from=agents-build /app/services/agents/.output ./.output')
    expect(content).toContain('CMD ["bun", "run", "start"]')
    expect(content).not.toContain('services/jangar')
    expect(content).not.toContain('.output/server/index.mjs')
  })

  it('builds the Agents service for the controller target', () => {
    const content = dockerfileTarget('controller')

    expect(content).toContain('WORKDIR /app/services/agents')
    expect(content).toContain('COPY --from=agents-build /app/services/agents/src ./src')
    expect(content).toContain('AGENTS_SERVER_PROFILE=agents-controllers')
    expect(content).toContain('CMD ["bun", "run", "src/server/controller-entrypoint.ts"]')
    expect(content).not.toContain('services/jangar')
    expect(content).not.toContain('.output/server/index.mjs')
  })

  it('keeps Jangar out of the Agents Dockerfile build graph', () => {
    expect(dockerfile()).not.toContain('services/jangar')
    expect(dockerfile()).not.toContain('@proompteng/jangar')
    expect(dockerfile()).not.toContain('codex-implement')
  })

  it('starts each target in its split Agents profile', () => {
    expect(dockerfileTarget('control-plane')).toContain('AGENTS_SERVER_PROFILE=agents-control-plane')
    expect(dockerfileTarget('controller')).toContain('AGENTS_SERVER_PROFILE=agents-controllers')
  })

  it('bundles repo-work Python tooling in the agents-shell target', () => {
    const content = dockerfileTarget('agents-shell')

    expect(content).toContain('python3-pip')
    expect(content).toContain('python3-venv')
    expect(content).toContain('python3 -m pip install --break-system-packages --no-cache-dir "uv==${UV_VERSION}"')
    expect(content).toContain('command -v bash git gh rg curl jq yq python3 uv ps wget kubectl apply_patch')
  })

  it('runs package builds on the build platform while keeping runtime dependencies target-native', () => {
    const content = dockerfile()

    expect(content).toContain('FROM --platform=$BUILDPLATFORM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS agents-build-tools')
    expect(content).toContain('FROM agents-build-tools AS agents-workspace-deps')
    expect(content).toContain('FROM agents-tools AS agents-deps-prod')
    expect(dockerfileTarget('agents-build-tools')).toContain('ARCH="${BUILDARCH:-$(uname -m)}"')
    expect(dockerfileTarget('agents-tools')).toContain('ARCH="${TARGETARCH:-$(uname -m)}"')
  })

  it('installs runtime helper CLIs from cx-tools rather than service-local scripts', () => {
    const content = dockerfile()

    expect(content).toContain(
      'ln -sf /app/packages/cx-tools/dist/codex-nats-publish.js /usr/local/bin/codex-nats-publish',
    )
    expect(content).toContain('ln -sf /app/packages/cx-tools/dist/codex-nats-soak.js /usr/local/bin/codex-nats-soak')
    expect(content).not.toContain('services/agents/scripts/codex/codex-nats-publish.ts')
    expect(content).not.toContain('services/agents/scripts/codex/codex-nats-soak.ts')
  })

  it('keeps runtime source imports independent of test-only path aliases', () => {
    const aliasedImports = listProductionSources(sourceRoot).flatMap((path) => {
      const content = readFileSync(path, 'utf8')
      return /(?:from\s+['"]|import\s*\(\s*['"])[@~]\//.test(content) ? [relative(sourceRoot, path)] : []
    })

    expect(aliasedImports).toEqual([])
  })

  it('keeps primitives reconciliation disabled only on the control-plane target', () => {
    expect(dockerfileTarget('control-plane')).toContain('AGENTS_PRIMITIVES_RECONCILER=0')
    expect(dockerfileTarget('controller')).not.toContain('AGENTS_PRIMITIVES_RECONCILER=0')
  })
})
