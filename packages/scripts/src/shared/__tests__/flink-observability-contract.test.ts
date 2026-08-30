import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Alloy scrapes Flink operator and TA metrics with alert-compatible labels', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const deployment = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml')
  const kustomization = readRepoFile('argocd/applications/observability/kustomization.yaml')

  expect(config).toContain('prometheus.scrape "flink"')
  expect(config).toContain('flink-operator-metrics.flink.svc.cluster.local:8080')
  expect(config).toContain('torghut-ta-metrics.torghut.svc.cluster.local:9249')
  expect(config).toContain('torghut-ta-sim-metrics.torghut.svc.cluster.local:9249')
  expect(config).toContain('"job"         = "torghut"')
  expect(config).toContain('"namespace"   = "torghut"')
  expect(config).toContain('"service"     = "torghut-ta-metrics"')
  expect(config).toContain('forward_to      = [prometheus.remote_write.mimir.receiver]')
  expect(kustomization).toContain('configMapGenerator:')
  expect(kustomization).toContain('config.river=cluster-metrics-alloy-config.river')
  expect(kustomization).toContain('disableNameSuffixHash: true')
  expect(deployment).toContain('name: observability-cluster-metrics-alloy')
  expect(deployment).toContain(
    `observability.proompteng.ai/config-sha256: ${createHash('sha256').update(config).digest('hex')}`,
  )
})

test('Ceph migration guide uses Hadoop S3A configuration keys', () => {
  const guide = readRepoFile('docs/torghut/ceph-migration.md')

  for (const key of [
    'fs.s3a.endpoint:',
    'fs.s3a.path.style.access:',
    'fs.s3a.access.key:',
    'fs.s3a.secret.key:',
    'fs.s3a.connection.maximum:',
  ]) {
    expect(guide).toContain(key)
  }

  expect(guide).not.toMatch(/^s3\./m)
  expect(guide).toContain('rgw service :80')
  expect(guide).toContain('CephObjectStore` (`objectstore`)')
  expect(guide).not.toContain('CephObjectStore` (`objstore`)')
  expect(guide).toContain('RGW service TCP/80')
  expect(guide).not.toContain('RGW service TCP/443')
  expect(guide).not.toContain('RGW:443')
})
