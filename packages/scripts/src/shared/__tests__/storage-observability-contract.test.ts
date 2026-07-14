import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('cluster Alloy collects bounded Torghut PostgreSQL and Ceph storage metrics', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const deployment = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml')

  expect(config).toContain('discovery.kubernetes "torghut_cnpg_pods"')
  expect(config).toContain('label = "cnpg.io/cluster=torghut-db"')
  expect(config).toContain('__meta_kubernetes_pod_container_port_name')
  expect(config).toContain('prometheus.relabel "torghut_cnpg_metrics"')
  expect(config).toContain('cnpg_collector_wal_(buffers_full|bytes|fpi|records|sync|sync_time|write|write_time)')
  expect(config).toContain('cnpg_pg_stat_checkpointer_')
  expect(config).toContain('prometheus.scrape "ceph_storage"')
  expect(config).toContain('rook-ceph-mgr.rook-ceph.svc.cluster.local:9283')
  expect(config).toContain('ceph_osd_(apply|commit)_latency_ms')
  expect(config).toContain('ceph_health_detail')
  expect(deployment).toContain(
    `observability.proompteng.ai/config-sha256: ${createHash('sha256').update(config).digest('hex')}`,
  )
})

test('Mimir records the storage baseline and alerts on actionable pressure', () => {
  const rules = readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')

  for (const contract of [
    'torghut_postgres:wal_bytes_per_second:rate5m',
    'torghut_postgres:requested_checkpoint_ratio:rate1h',
    'ceph_storage:osd_commit_latency_ms:max',
    'ceph_storage:pool_write_bytes_per_second:rate5m',
    'alert: TorghutPostgresMetricsMissing',
    'alert: CephStorageMetricsMissing',
    'alert: CephClusterHealthWarning',
    'alert: CephClusterHealthError',
    'alert: CephOsdCommitLatencyHigh',
    'alert: CephOsdCommitLatencyCritical',
    'alert: CephScrubDebt',
    'alert: CephScrubbingDisabled',
    'alert: TorghutPostgresForcedCheckpointsHigh',
    'alert: TorghutPostgresWalBuffersFull',
  ]) {
    expect(rules).toContain(contract)
  }
})
