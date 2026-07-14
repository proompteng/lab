import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('cluster Alloy collects bounded CloudNativePG and Ceph storage metrics', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const deployment = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml')
  const kustomization = readRepoFile('argocd/applications/observability/kustomization.yaml')
  const mimirValues = readRepoFile('argocd/applications/observability/mimir-values.yaml')

  expect(config).toContain('discovery.kubernetes "cnpg_pods"')
  expect(config).toContain('label = "cnpg.io/cluster"')
  expect(config).toContain('__meta_kubernetes_pod_container_port_name')
  expect(config).toContain('prometheus.relabel "cnpg_metrics"')
  expect(config).toContain('job_name        = "cnpg-postgres"')
  expect(config).toContain('cnpg_collector_pg_wal(_archive_status)?')
  expect(config).toContain('cnpg_collector_wal_(buffers_full|bytes|fpi|records|sync|sync_time|write|write_time)')
  expect(config).toContain('cnpg_pg_stat_checkpointer_')
  expect(config).toContain('prometheus.scrape "ceph_storage"')
  expect(config).toContain('rook-ceph-mgr.rook-ceph.svc.cluster.local:9283')
  expect(config).toContain('ceph_osd_(apply|commit)_latency_ms')
  expect(config).toContain('ceph_health_detail')
  expect(config).toContain('prometheus.relabel "rbd_client_metrics"')
  expect(config).toContain('container_fs_(reads|writes)(_bytes)?_total;/dev/rbd[0-9]+;;.+')
  expect(config).toContain('prometheus.relabel.rbd_client_metrics.receiver')
  expect(mimirValues).toContain(
    'kafka:\n  persistence:\n    enabled: true\n    size: 20Gi\n    storageClassName: rook-ceph-block',
  )
  expect(kustomization).toContain(
    'name: observability-mimir-kafka\n    patch: |-\n      apiVersion: apps/v1\n      kind: StatefulSet',
  )
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
    'ceph_storage:rbd_pod_write_bytes_per_second:rate5m',
    'ceph_storage:rbd_pod_write_iops:rate5m',
    'alert: TorghutPostgresMetricsMissing',
    'alert: CloudNativePgWalArchiveBacklog',
    'alert: PersistentVolumeFreeLowWarning',
    'alert: PersistentVolumeFreeLowCritical',
    'alert: CephStorageMetricsMissing',
    'alert: CephClusterHealthWarning',
    'alert: CephClusterHealthError',
    'alert: CephSlowOps',
    'alert: CephOsdCommitLatencyHigh',
    'alert: CephOsdCommitLatencyCritical',
    'alert: CephScrubDebt',
    'alert: CephScrubbingDisabled',
    'alert: TorghutPostgresForcedCheckpointsHigh',
    'alert: TorghutPostgresWalBuffersFull',
  ]) {
    expect(rules).toContain(contract)
  }

  expect(rules).toContain('max(ceph_osd_flag_noscrub{job="ceph-storage"}) > 0 or')
  expect(rules).toContain('max(ceph_osd_flag_nodeep_scrub{job="ceph-storage"}) > 0')
  expect(rules).toContain(
    'sum(\n                increase(\n                  cnpg_pg_stat_checkpointer_checkpoints_req{',
  )
})
