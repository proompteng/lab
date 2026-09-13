import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('cluster Alloy collects bounded CloudNativePG and Ceph storage metrics', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const deployment = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml')

  expect(config).toContain('discovery.kubernetes "cnpg_pods"')
  expect(config).toContain('label = "cnpg.io/cluster"')
  expect(config).toContain('__meta_kubernetes_pod_container_port_name')
  expect(config).toContain('prometheus.relabel "cnpg_metrics"')
  expect(config).toContain('job_name        = "cnpg-postgres"')
  expect(config).toContain('cnpg_collector_pg_wal(_archive_status)?')
  expect(config).toContain('cnpg_collector_wal_(buffers_full|bytes|fpi|records|sync|sync_time|write|write_time)')
  expect(config).toContain('cnpg_pg_stat_checkpointer_')
  expect(config).toContain('cnpg_pg_replication_slots_(active|pg_wal_lsn_diff)')
  expect(config).toContain('prometheus.scrape "ceph_storage"')
  expect(config).toContain('rook-ceph-mgr.rook-ceph.svc.cluster.local:9283')
  expect(config).toContain('ceph_osd_(apply|commit)_latency_ms')
  expect(config).toContain('ceph_health_detail')
  expect(config).toContain('prometheus.relabel "rbd_client_metrics"')
  expect(config).toContain('container_fs_(reads|writes)(_bytes)?_total;/dev/rbd[0-9]+;;.+')
  expect(config).toContain('prometheus.relabel.rbd_client_metrics.receiver')
  expect(deployment).toContain(
    `observability.proompteng.ai/config-sha256: ${createHash('sha256').update(config).digest('hex')}`,
  )
})

test('Mimir uses the replicated shared Kafka topic with cluster-local offsets', () => {
  const values = YAML.parse(readRepoFile('argocd/applications/observability/mimir-values.yaml'))
  const topic = YAML.parse(readRepoFile('argocd/applications/kafka/mimir-topic.yaml'))
  const kafkaResources = YAML.parse(readRepoFile('argocd/applications/kafka/kustomization.yaml')).resources
  const config = values.mimir.structuredConfig.ingest_storage

  expect(values.kafka).toEqual({ enabled: false })
  expect(config).toMatchObject({
    enabled: true,
    kafka: {
      address: 'kafka-kafka-bootstrap.kafka.svc.cluster.local:9093',
      topic: topic.metadata.name,
      auto_create_topic_enabled: false,
      consumer_group_offset_commit_file_enforced: false,
    },
  })
  expect(kafkaResources).toContain('mimir-topic.yaml')
  expect(topic.metadata.labels['strimzi.io/cluster']).toBe('kafka')
  expect(topic.spec.partitions).toBeGreaterThanOrEqual(values.ingester.replicas)
  expect(topic.spec.replicas).toBe(3)
  expect(topic.spec.config['min.insync.replicas']).toBe(2)
  expect(topic.spec.config['max.message.bytes']).toBeGreaterThanOrEqual(16000000)
  expect(topic.spec.config['retention.ms']).toBeGreaterThanOrEqual(86400000)
})

test('Mimir records the storage baseline and alerts on actionable pressure', () => {
  const rules = readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')

  for (const contract of [
    'torghut_postgres:wal_bytes_per_second:rate5m',
    'torghut_postgres:requested_checkpoint_ratio:rate1h',
    'ceph_storage:osd_commit_latency_ms:max',
    'ceph_storage:pool_write_bytes_per_second:rate5m',
    'ceph_storage:scrubbing_pgs:sum',
    'ceph_storage:rbd_pod_write_bytes_per_second:rate5m',
    'ceph_storage:rbd_pod_write_iops:rate5m',
    'alert: CloudNativePgWalArchiveBacklog',
    'alert: CloudNativePgReplicationSlotWalRetentionHigh',
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

  for (const retired of ['TorghutPostgresMetricsMissing', 'TorghutApiServiceMissing', 'TorghutLLMTelemetryMissing']) {
    expect(rules).not.toContain(`alert: ${retired}`)
  }

  expect(rules).toContain('max(ceph_osd_flag_noscrub{job="ceph-storage"}) > 0 or')
  expect(rules).toContain('max(ceph_osd_flag_nodeep_scrub{job="ceph-storage"}) > 0')
  expect(rules).toContain('expr: sum(ceph_pg_scrubbing{job="ceph-storage"})')
  expect(rules).not.toContain('sum(ceph_pg_scrubbing{job="ceph-storage"}) +')
  expect(rules).toContain(
    'sum(\n                increase(\n                  cnpg_pg_stat_checkpointer_checkpoints_req{',
  )
  expect(rules).not.toMatch(/^\s+(description|summary): \{\{/m)
})
