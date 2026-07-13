import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Alloy scrapes Flink operator and TA metrics with alert-compatible labels', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-configmap.yaml')

  expect(config).toContain('prometheus.scrape "flink"')
  expect(config).toContain('flink-operator-metrics.flink.svc.cluster.local:8080')
  expect(config).toContain('torghut-ta-metrics.torghut.svc.cluster.local:9249')
  expect(config).toContain('torghut-ta-sim-metrics.torghut.svc.cluster.local:9249')
  expect(config).toContain('"job"         = "torghut"')
  expect(config).toContain('"namespace"   = "torghut"')
  expect(config).toContain('"service"     = "torghut-ta-metrics"')
  expect(config).toContain('forward_to      = [prometheus.remote_write.mimir.receiver]')
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
  expect(guide).toContain('RGW service TCP/80')
  expect(guide).not.toContain('RGW service TCP/443')
  expect(guide).not.toContain('RGW:443')
})
