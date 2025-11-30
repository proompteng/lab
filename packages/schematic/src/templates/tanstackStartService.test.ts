import { buildTanstackStartService } from './tanstackStartService'

const asPaths = (files: { path: string }[]) => files.map((f) => f.path)

test('includes domain mapping and cluster-domain-claim when exposure is external-dns', () => {
  const files = buildTanstackStartService({
    name: 'alpha',
    imageRegistry: 'registry.example.com',
    exposure: 'external-dns',
  })

  expect(asPaths(files)).toContain('argocd/applications/alpha/base/domain-mapping.yaml')
  expect(asPaths(files)).toContain('argocd/applications/alpha/base/cluster-domain-claim.yaml')
  expect(asPaths(files)).not.toContain('argocd/applications/alpha/base/tailscale-service.yaml')
})

test('includes tailscale service and omits domain mapping when exposure is tailscale', () => {
  const files = buildTanstackStartService({
    name: 'beta',
    imageRegistry: 'registry.example.com',
    exposure: 'tailscale',
    tailscaleHostname: 'beta-ts',
  })

  expect(asPaths(files)).toContain('argocd/applications/beta/base/tailscale-service.yaml')
  expect(asPaths(files)).not.toContain('argocd/applications/beta/base/domain-mapping.yaml')
  expect(asPaths(files)).not.toContain('argocd/applications/beta/base/cluster-domain-claim.yaml')
})

test('adds postgres manifest and docker-compose when Postgres enabled', () => {
  const files = buildTanstackStartService({
    name: 'gamma',
    imageRegistry: 'registry.example.com',
    enablePostgres: true,
  })

  expect(asPaths(files)).toContain('argocd/applications/gamma/base/postgres.yaml')
  const compose = files.find((f) => f.path === 'services/gamma/docker-compose.yml')
  expect(compose?.contents).toContain('postgres:16')
})

test('adds redis manifest and docker-compose when Redis enabled', () => {
  const files = buildTanstackStartService({
    name: 'delta',
    imageRegistry: 'registry.example.com',
    enableRedis: true,
  })

  expect(asPaths(files)).toContain('argocd/applications/delta/base/redis.yaml')
  const compose = files.find((f) => f.path === 'services/delta/docker-compose.yml')
  expect(compose?.contents).toContain('redis:7-alpine')
})
