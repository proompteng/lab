import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

const metricAllowlist = (config: string, name: string): RegExp => {
  const block = config.match(new RegExp(`prometheus\\.relabel "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1]
  const encoded = block?.match(/regex\s*=\s*("(?:[^"\\]|\\.)*")/)?.[1]
  if (!encoded) throw new Error(`Missing metric allowlist: ${name}`)
  return new RegExp(`^(?:${JSON.parse(encoded)})$`)
}

test('CNPG relabeling retains the complete bounded database diagnostics and collector failures', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const allow = metricAllowlist(config, 'cnpg_metrics')
  const manifest = YAML.parse(readRepoFile('argocd/applications/bayn/postgres-monitoring.yaml'))
  const queries = YAML.parse(manifest.data.queries) as Record<
    string,
    { metrics: Array<Record<string, { usage: string }>> }
  >
  // Exercise the retained metric names produced by the configured exporter; labels are not themselves metric samples.
  for (const [query, { metrics }] of Object.entries(queries)) {
    for (const metric of metrics) {
      for (const [name, definition] of Object.entries(metric)) {
        if (definition.usage === 'LABEL') continue
        expect(allow.test(`cnpg_${query}_${name};`)).toBe(true)
      }
    }
  }
  for (const sample of [
    'up;',
    'scrape_duration_seconds;',
    'cnpg_collector_last_collection_error;',
    'cnpg_collector_collection_errors_total;',
    'cnpg_collector_collection_duration_seconds;',
    'cnpg_pg_settings_setting;track_io_timing',
    'cnpg_pg_settings_setting;track_wal_io_timing',
    'cnpg_pg_settings_setting;fsync',
    'cnpg_collector_wal_bytes;',
    'cnpg_pg_stat_checkpointer_sync_time;',
  ])
    expect(allow.test(sample)).toBe(true)
  for (const sample of [
    'cnpg_bayn_unbounded_future_metric;',
    'cnpg_bayn_io_write_seconds_total_extra;',
    'cnpg_pg_settings_setting;application_name',
    'unrelated_metric;',
  ])
    expect(allow.test(sample)).toBe(false)
})

test('Bayn database diagnostics use one fast scrape without duplicating other database targets', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const route = (name: string, action: 'keep' | 'drop') => {
    const block = config.match(new RegExp(`discovery\\.relabel "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1]
    if (!block) throw new Error(`Missing database target route: ${name}`)
    expect(block).toMatch(/targets\s*=\s*discovery\.relabel\.cnpg_metrics\.output/)
    expect(block).toMatch(new RegExp(`action\\s*=\\s*"${action}"`))
    expect(block).toMatch(/source_labels\s*=\s*\["namespace", "cluster"\]/)
    const encoded = block.match(/regex\s*=\s*("(?:[^"\\]|\\.)*")/)?.[1]
    if (!encoded) throw new Error(`Missing database target selector: ${name}`)
    const matches = new RegExp(`^(?:${JSON.parse(encoded)})$`)
    return (namespace: string, cluster: string) => matches.test(`${namespace};${cluster}`) === (action === 'keep')
  }
  const fast = route('cnpg_bayn_metrics', 'keep')
  const ordinary = route('cnpg_other_metrics', 'drop')
  for (const [namespace, cluster, expected] of [
    ['bayn', 'bayn-db', 'fast'],
    ['bayn', 'bayn-db-new', 'ordinary'],
    ['bayn', '', 'ordinary'],
    ['bayn-new', 'bayn-db', 'ordinary'],
    ['torghut', 'torghut-db', 'ordinary'],
    ['buzz', 'buzz-db', 'ordinary'],
    ['', '', 'ordinary'],
  ]) {
    expect([
      ...(fast(namespace, cluster) ? ['fast'] : []),
      ...(ordinary(namespace, cluster) ? ['ordinary'] : []),
    ]).toEqual([expected])
  }
  const fastScrape = config.match(/prometheus\.scrape "cnpg_bayn" \{([\s\S]*?)\n\}/)?.[1]
  const ordinaryScrape = config.match(/prometheus\.scrape "cnpg" \{([\s\S]*?)\n\}/)?.[1]
  expect(fastScrape).toMatch(/targets\s*=\s*discovery\.relabel\.cnpg_bayn_metrics\.output/)
  expect(fastScrape).toMatch(/scrape_interval\s*=\s*"5s"/)
  expect(fastScrape).toMatch(/scrape_timeout\s*=\s*"4s"/)
  expect(ordinaryScrape).toMatch(/targets\s*=\s*discovery\.relabel\.cnpg_other_metrics\.output/)
  expect(ordinaryScrape).toMatch(/scrape_interval\s*=\s*"30s"/)
  for (const scrape of [fastScrape, ordinaryScrape]) {
    expect(scrape).toMatch(/job_name\s*=\s*"cnpg-postgres"/)
    expect(scrape).toMatch(/forward_to\s*=\s*\[prometheus\.relabel\.cnpg_metrics\.receiver\]/)
  }
})

test('Ceph exporter discovery is per pod and keeps complete latency-counter pairs', () => {
  const config = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  expect(config).toContain('label = "app=rook-ceph-exporter"')
  expect(config).toContain('regex         = "ceph-exporter;http-metrics"')
  expect(config).toContain('targets         = discovery.relabel.ceph_exporters.output')
  expect(config).not.toContain('rook-ceph-exporter.rook-ceph.svc.cluster.local:9926')
  const allow = metricAllowlist(config, 'ceph_daemon_metrics')
  for (const name of [
    'up',
    'ceph_osd_op_r',
    'ceph_osd_op_w_in_bytes',
    'ceph_osd_op_r_latency_sum',
    'ceph_osd_op_r_latency_count',
    'ceph_osd_op_process_latency_sum',
    'ceph_osd_op_process_latency_count',
    'ceph_bluefs_fsync_lat_sum',
    'ceph_bluefs_fsync_lat_count',
    'ceph_bluefs_slow_used_bytes',
    'ceph_bluestore_state_kv_queued_lat_sum',
    'ceph_rocksdb_compact_queue_len',
  ])
    expect(allow.test(name)).toBe(true)
  for (const name of ['ceph_rgw_req', 'ceph_mds_request', 'unrelated_metric', 'ceph_osd_op_r_latency_sum_extra']) {
    expect(allow.test(name)).toBe(false)
  }
})

test('host storage collector reads host counters without a public listener or Kubernetes authority', () => {
  const manifest = YAML.parse(readRepoFile('argocd/applications/rook-ceph/host-metrics-alloy-daemonset.yaml'))
  const config = readRepoFile('argocd/applications/rook-ceph/host-metrics-alloy-config.river')
  const central = YAML.parse(readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml'))
  const pod = manifest.spec.template.spec
  const container = pod.containers[0]
  expect(pod.hostNetwork).toBe(true)
  expect(pod.hostPID ?? false).toBe(false)
  expect(pod.automountServiceAccountToken).toBe(false)
  expect(pod.dnsPolicy).toBe('ClusterFirstWithHostNet')
  expect(container.image).toBe(central.spec.template.spec.containers[0].image)
  expect(container.args).toContain('--server.http.listen-addr=127.0.0.1:12346')
  expect(container.securityContext.privileged ?? false).toBe(false)
  expect(container.securityContext.readOnlyRootFilesystem).toBe(true)
  expect(container.securityContext.allowPrivilegeEscalation).toBe(false)
  expect(container.securityContext.capabilities.drop).toEqual(['ALL'])
  for (const volume of pod.volumes.filter((entry: { hostPath?: unknown }) => entry.hostPath)) {
    expect(['/proc', '/sys']).toContain(volume.hostPath.path)
    expect(container.volumeMounts.find((entry: { name: string }) => entry.name === volume.name).readOnly).toBe(true)
  }
  const kustomization = YAML.parse(readRepoFile('argocd/applications/rook-ceph/kustomization.yaml'))
  expect(kustomization.resources).toContain('host-metrics-alloy-daemonset.yaml')
  expect(kustomization.generatorOptions?.disableNameSuffixHash ?? false).toBe(false)
  expect(kustomization.configMapGenerator).toContainEqual({
    name: 'rook-ceph-host-metrics-alloy',
    files: ['config.river=host-metrics-alloy-config.river'],
  })
  expect(config).toMatch(/procfs_path\s*=\s*"\/host\/proc"/)
  expect(config).toMatch(/sysfs_path\s*=\s*"\/host\/sys"/)
  const deviceFilter = config.match(/device_include\s*=\s*"([^"]+)"/)?.[1]
  if (!deviceFilter) throw new Error('Missing host storage device filter')
  const devices = new RegExp(deviceFilter)
  for (const device of ['sda', 'sdaa', 'nvme0n1', 'nvme3n1', 'rbd0', 'rbd1', 'rbd13'])
    expect(devices.test(device)).toBe(true)
  for (const device of ['loop0', 'ram0', 'sda1', 'nvme0n1p4', 'rbd1p1', 'rbd1-extra'])
    expect(devices.test(device)).toBe(false)
  expect(config).toContain('sys.env("NODE_NAME")')
  // Exporter-provided target labels override scrape job_name. The discovered
  // integrations/unix label must be replaced before these targets are scraped.
  const discovery = config.match(/discovery\.relabel "storage" \{([\s\S]*?)\n\}/)?.[1]
  expect(discovery).toMatch(/replacement\s*=\s*"node-storage"\s+target_label\s*=\s*"job"/)
  expect(config).not.toContain('discovery.kubernetes')
  const allow = metricAllowlist(config, 'storage')
  for (const name of [
    'up',
    'node_disk_read_time_seconds_total',
    'node_disk_io_time_weighted_seconds_total',
    'node_network_speed_bytes',
    'node_network_receive_drop_total',
    'node_pressure_io_stalled_seconds_total',
    'node_scrape_collector_success',
  ])
    expect(allow.test(name)).toBe(true)
  expect(allow.test('node_filesystem_size_bytes')).toBe(false)
})

test('Ceph performance rules preserve missing-data semantics and inventory coverage', () => {
  const manifest = YAML.parse(readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml'))
  const documents = Object.values(manifest.data).map((value) => YAML.parse(value as string))
  const group = documents
    .flatMap((document) => document.groups ?? [])
    .find((entry) => entry.name === 'ceph-performance.rules')
  expect(group).toBeDefined()
  const rules = group.rules as Array<{ record?: string; alert?: string; expr: string }>
  for (const rule of rules.filter((entry) => entry.record?.endsWith('mean5m') && entry.expr.includes('/'))) {
    expect(rule.expr).toContain('> 0)')
    expect(rule.expr).not.toContain('or vector(0)')
  }
  expect(rules.find((entry) => entry.alert === 'NodeStorageMetricsMissing')?.expr).toContain('unless on (node)')
  expect(rules.find((entry) => entry.alert === 'CephOsdPerformanceMetricsMissing')?.expr).toContain(
    'unless on (ceph_daemon)',
  )
  expect(rules.find((entry) => entry.alert === 'NodeStorageCollectorFailed')?.expr).toContain(
    'node_scrape_collector_success',
  )
})

test('Ceph scrub catch-up retains calibrated capacity without ineffective scrub or recovery overrides', () => {
  const values = YAML.parse(readRepoFile('argocd/applications/rook-ceph/cluster-values.yaml'))
  const config = values.cephClusterSpec.cephConfig
  for (const key of [
    'osd_mclock_override_recovery_settings',
    'osd_max_backfills',
    'osd_recovery_max_active',
    'osd_recovery_max_active_hdd',
    'osd_scrub_sleep',
  ])
    expect(config.osd[key]).toBeUndefined()
  expect(config.osd.osd_mclock_profile).toBe('custom')
  expect(config.osd.osd_scrub_begin_hour).toBe('0')
  expect(config.osd.osd_scrub_end_hour).toBe('0')
  expect(config.osd.osd_max_scrubs).toBe('1')
  expect([0, 1, 2, 3, 4, 5].map((id) => config[`osd.${id}`].osd_mclock_max_capacity_iops_hdd)).toEqual([
    '210',
    '250',
    '260',
    '200',
    '220',
    '240',
  ])
})

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
