import { expect, test } from 'bun:test'
import { buildTanstackStartService, mergeTanstackServiceScripts } from './create-service'
import type { TanstackServiceOptions } from './types'

const asPaths = (files: { path: string }[]) => files.map((f) => f.path)

const stubScaffold = async (opts: TanstackServiceOptions) => [
  { path: `services/${opts.name}/package.json`, contents: '{}' },
]

test('adds oxlint scripts required by generated CI', () => {
  const scripts = mergeTanstackServiceScripts({})

  expect(scripts['lint:oxlint']).toBe('oxlint --config ../../.oxlintrc.json .')
  expect(scripts['lint:oxlint:type']).toBe(
    'oxlint --config ../../.oxlintrc.json --type-aware --tsconfig ./tsconfig.json .',
  )
})

test('keeps oxlint scripts when Postgres scripts are enabled', () => {
  const scripts = mergeTanstackServiceScripts({}, { enablePostgres: true })

  expect(scripts.generate).toBe('bunx drizzle-kit generate --config drizzle.config.ts')
  expect(scripts.migrate).toBe('bunx drizzle-kit push --config drizzle.config.ts')
  expect(scripts['lint:oxlint']).toBe('oxlint --config ../../.oxlintrc.json .')
  expect(scripts['lint:oxlint:type']).toBe(
    'oxlint --config ../../.oxlintrc.json --type-aware --tsconfig ./tsconfig.json .',
  )
})

test('includes domain mapping and cluster-domain-claim when exposure is external-dns', async () => {
  const files = await buildTanstackStartService(
    {
      name: 'alpha',
      imageRegistry: 'registry.example.com',
      exposure: 'external-dns',
    },
    { scaffold: stubScaffold },
  )

  expect(asPaths(files)).toContain('argocd/applications/alpha/base/domain-mapping.yaml')
  expect(asPaths(files)).toContain('argocd/applications/alpha/base/cluster-domain-claim.yaml')
  expect(asPaths(files)).not.toContain('argocd/applications/alpha/base/tailscale-service.yaml')
})

test('includes tailscale service and omits domain mapping when exposure is tailscale', async () => {
  const files = await buildTanstackStartService(
    {
      name: 'beta',
      imageRegistry: 'registry.example.com',
      exposure: 'tailscale',
      tailscaleHostname: 'beta-ts',
    },
    { scaffold: stubScaffold },
  )

  expect(asPaths(files)).toContain('argocd/applications/beta/base/tailscale-service.yaml')
  expect(asPaths(files)).not.toContain('argocd/applications/beta/base/domain-mapping.yaml')
  expect(asPaths(files)).not.toContain('argocd/applications/beta/base/cluster-domain-claim.yaml')
})

test('adds postgres manifest and docker-compose when Postgres enabled', async () => {
  const files = await buildTanstackStartService(
    {
      name: 'gamma',
      imageRegistry: 'registry.example.com',
      enablePostgres: true,
    },
    { scaffold: stubScaffold },
  )

  expect(asPaths(files)).toContain('argocd/applications/gamma/base/postgres.yaml')
  const compose = files.find((f) => f.path === 'services/gamma/docker-compose.yml')
  expect(compose?.contents).toContain('postgres:16')
})

test('adds redis manifest and docker-compose when Redis enabled', async () => {
  const files = await buildTanstackStartService(
    {
      name: 'delta',
      imageRegistry: 'registry.example.com',
      enableRedis: true,
    },
    { scaffold: stubScaffold },
  )

  expect(asPaths(files)).toContain('argocd/applications/delta/base/redis.yaml')
  const compose = files.find((f) => f.path === 'services/delta/docker-compose.yml')
  expect(compose?.contents).toContain('redis:7-alpine')
})

test('adds drizzle config + schema when Postgres enabled', async () => {
  const files = await buildTanstackStartService(
    {
      name: 'eta',
      imageRegistry: 'registry.example.com',
      enablePostgres: true,
    },
    { scaffold: stubScaffold },
  )

  expect(asPaths(files)).toContain('services/eta/drizzle.config.ts')
  expect(asPaths(files)).toContain('services/eta/src/db/schema/app.ts')
})

test('omits drizzle files when Postgres disabled', async () => {
  const files = await buildTanstackStartService(
    {
      name: 'theta',
      imageRegistry: 'registry.example.com',
      enablePostgres: false,
    },
    { scaffold: stubScaffold },
  )

  expect(asPaths(files)).not.toContain('services/theta/drizzle.config.ts')
  expect(asPaths(files)).not.toContain('services/theta/src/db/schema/app.ts')
})
