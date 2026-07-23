import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')
const buzzFile = (name: string): string => readRepoFile(`argocd/applications/buzz/${name}`)

describe('Buzz production GitOps contract', () => {
  test('keeps the owner identity valid and human-owned', () => {
    const values = buzzFile('values.yaml')
    const ownerPubkey = values.match(/^ownerPubkey:\s+"([0-9a-f]{64})"$/m)?.[1]

    expect(ownerPubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(ownerPubkey).not.toBe('0'.repeat(64))
    expect(values).not.toContain('nsec1')
  })

  test('uses the pinned upstream chart and digest-pinned workload images', () => {
    const kustomization = buzzFile('kustomization.yaml')
    const postgres = buzzFile('postgres-cluster.yaml')
    const redis = buzzFile('redis.yaml')
    const alloy = buzzFile('alloy-deployment.yaml')

    expect(kustomization).toContain('version: 0.1.6')
    expect(kustomization).toContain('sha256:88b96378cabd6b64c9bb8da9824a608daac3b0965d2aa17019e70248c07d517c')

    for (const manifest of [kustomization, postgres, redis, alloy]) {
      expect(manifest).toContain('sha256:')
    }
  })

  test('uses external stateful dependencies and Ceph while keeping unsafe features off', () => {
    const values = buzzFile('values.yaml')
    const postgres = buzzFile('postgres-cluster.yaml')
    const redis = buzzFile('redis.yaml')
    const buckets = buzzFile('objectbucketclaims.yaml')
    const networkPolicy = buzzFile('networkpolicy.yaml')

    for (const contract of [
      'replicaCount: 2',
      'requireAuthToken: true',
      'requireRelayMembership: true',
      'huddleAudioAvailable: false',
      'pairingRelay:\n  enabled: false',
      'persistence:\n  git:\n    enabled: false',
      'postgresql:\n  enabled: false',
      'redis:\n  enabled: false',
      'minio:\n  enabled: false',
      'serviceMonitor:\n  enabled: false',
      'autoMigrate: true',
      'http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80',
    ]) {
      expect(values).toContain(contract)
    }

    expect(postgres).toContain('instances: 3')
    expect(postgres).toContain('minSyncReplicas: 1')
    expect(postgres).toContain('maxSyncReplicas: 1')
    expect(postgres).toContain('storageClass: rook-ceph-block')
    expect(postgres).toContain('size: 20Gi')
    expect(redis).toContain('appendonly yes')
    expect(redis).toContain('appendfsync everysec')
    expect(redis).toContain('storage: 5Gi')
    expect(buckets).toContain('bucketName: buzz-objects')
    expect(buckets).toContain('bucketName: cnpg-buzz')
    expect(buckets.match(/argocd\.argoproj\.io\/sync-options: Prune=false,Delete=false/g)).toHaveLength(2)
    expect(networkPolicy).toContain('name: default-deny-ingress')
    expect(networkPolicy).toContain('app.kubernetes.io/name: observability-cluster-metrics-alloy')
    expect(networkPolicy).toContain('port: 9187')
  })

  test('keeps credentials out of Git and combines generated credentials through External Secrets', () => {
    const runtime = buzzFile('redis-auth-externalsecret.yaml')
    const aggregate = buzzFile('buzz-externalsecret.yaml')
    const store = buzzFile('secret-store.yaml')

    expect(runtime).toContain('name: onepassword-infra')
    expect(runtime).toContain('key: buzz-runtime')
    expect(runtime).toContain('property: REDIS_PASSWORD')
    expect(aggregate).toContain('name: buzz-kubernetes')
    expect(aggregate).toContain('key: buzz-db-app')
    expect(aggregate).toContain('key: buzz-objects')
    expect(aggregate).toContain('property: RELAY_PRIVATE_KEY')
    expect(aggregate).toContain('property: GIT_HOOK_HMAC_SECRET')
    expect(aggregate).toContain('property: REDIS_PASSWORD')
    expect(aggregate).toContain("DATABASE_URL: '{{ .database_uri }}?sslmode=require'")
    expect(store).toContain('kind: SecretStore')
    expect(store).toContain('remoteNamespace: buzz')
    expect(store).toContain('selfsubjectrulesreviews')
  })

  test('starts with manual Argo reconciliation and a protected restricted namespace', () => {
    const applicationSet = readRepoFile('argocd/applicationsets/platform.yaml')
    const buzzEntry = applicationSet.match(/              - name: buzz[\s\S]*?(?=\n              - name:)/)?.[0]

    expect(buzzEntry).toContain('namespace: buzz')
    expect(buzzEntry).toContain('automation: manual')
    expect(buzzEntry).toContain('external-secrets.proompteng.ai/enabled: "true"')
    expect(buzzEntry).toContain('pod-security.kubernetes.io/enforce: restricted')
    expect(buzzEntry).toContain('argocd.argoproj.io/sync-options: Prune=false')
    expect(buzzEntry).not.toContain('kind: Namespace')
  })

  test('covers relay, Redis, database, WAL, and backup health in Mimir', () => {
    const rules = readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')
    const kubeStateMetrics = readRepoFile('argocd/applications/observability/kube-state-metrics-values.yaml')
    const clusterAlloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')

    for (const alert of [
      'BuzzRelayUnavailable',
      'BuzzRelayReplicaDegraded',
      'BuzzContainerRestarting',
      'BuzzRedisUnavailable',
      'BuzzRedisMemoryHigh',
      'BuzzPostgresReplicaDegraded',
      'BuzzPostgresBackupStale',
      'CloudNativePgWalArchiveBacklog',
    ]) {
      expect(rules).toContain(`alert: ${alert}`)
    }

    expect(kubeStateMetrics).toContain('kind: Backup')
    expect(kubeStateMetrics).toContain('kind: ScheduledBackup')
    expect(kubeStateMetrics).toContain('name: backup_stopped_at')
    expect(clusterAlloy).toContain('kube_cnpg_backup_stopped_at')
    expect(clusterAlloy).toContain('kube_cnpg_scheduled_backup_last_schedule_time')
  })
})
