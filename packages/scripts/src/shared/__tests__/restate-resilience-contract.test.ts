import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Restate snapshot foundation preserves the singleton while preparing safe cluster membership', () => {
  const statefulSet = YAML.parse(readRepoFile('argocd/applications/restate/statefulset.yaml')) as Record<string, any>
  const env = new Map(
    statefulSet.spec.template.spec.containers[0].env.map((entry: { name: string; value?: string }) => [
      entry.name,
      entry.value,
    ]),
  )

  expect(statefulSet.spec.replicas).toBe(1)
  expect(statefulSet.spec.template.spec.containers[0].image).toBe('docker.restate.dev/restatedev/restate:1.7.2')
  expect(statefulSet.spec.template.spec.terminationGracePeriodSeconds).toBe(90)
  expect(statefulSet.spec.template.spec.topologySpreadConstraints[0].topologyKey).toBe('kubernetes.io/hostname')
  expect(statefulSet.spec.template.spec.topologySpreadConstraints[0].whenUnsatisfiable).toBe('DoNotSchedule')
  expect(
    statefulSet.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution,
  ).toHaveLength(1)
  expect(env.get('RESTATE_AUTO_PROVISION')).toBe('false')
  expect(env.get('RESTATE_METADATA_CLIENT__ADDRESSES')).toBe(
    '["http://restate-0.restate-cluster:5122","http://restate-1.restate-cluster:5122","http://restate-2.restate-cluster:5122"]',
  )
  expect(env.get('RESTATE_DEFAULT_REPLICATION')).toBe('1')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__DESTINATION')).toBe('s3://restate-snapshots/partitions')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__SNAPSHOT_INTERVAL')).toBe('30m')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__NUM_RETAINED')).toBe('2')
})

test('Restate snapshots use the existing Rook OBC contract and block rollout until all partitions are archived', () => {
  const obc = YAML.parse(readRepoFile('argocd/applications/restate/objectbucketclaim.yaml')) as Record<string, any>
  const bootstrap = readRepoFile('argocd/applications/restate/snapshot-bootstrap-job.yaml')
  const rollback = readRepoFile('argocd/applications/restate/singleton-rollback-guard.yaml')
  const kustomization = readRepoFile('argocd/applications/restate/kustomization.yaml')

  expect(obc.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('-1')
  expect(obc.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  expect(obc.spec.bucketName).toBe('restate-snapshots')
  expect(obc.spec.storageClassName).toBe('rook-ceph-bucket')
  expect(bootstrap).toContain('argocd.argoproj.io/hook: PostSync')
  expect(bootstrap.match(/restatectl --address "\$address" snapshots create/g)).toHaveLength(1)
  expect(bootstrap).toContain('backoffLimit: 0')
  expect(bootstrap).toContain('while [ "$SECONDS" -lt 840 ]')
  expect(bootstrap).toContain('if (!(i in seen) || !(i in archived)) exit 1')
  expect(bootstrap).toContain('Transient failure reading partition snapshot status; retrying')
  expect(bootstrap).toContain('Snapshot bootstrap did not create all 24 partition snapshots')
  expect(bootstrap).toContain('docker.restate.dev/restatedev/restate:1.7.2')
  expect(rollback).toContain('argocd.argoproj.io/hook: PreSync')
  expect(rollback).toContain('config set --replication 1')
  expect(rollback).toContain('set-storage-state --nodes "$remove_ids" --storage-state read-only')
  expect(rollback).toContain('set-worker-state --nodes "$remove_ids" --worker-state draining')
  expect(rollback).toContain('metadata-server remove-node "$remove_ids"')
  expect(rollback).toContain('create_all_partition_snapshots --trim-log')
  expect(rollback).toContain('Refusing rollback before all safety snapshots are archived')
  expect(kustomization).toContain('- objectbucketclaim.yaml')
  expect(kustomization).toContain('- singleton-rollback-guard.yaml')
  expect(kustomization).toContain('- snapshot-bootstrap-job.yaml')
})

test('Restate admin exposure remains tailnet-restricted', () => {
  const networkPolicy = readRepoFile('argocd/applications/restate/networkpolicy.yaml')
  const ingress = readRepoFile('argocd/applications/restate/admin-tailscale-ingress.yaml')
  const service = readRepoFile('argocd/applications/restate/service.yaml')

  expect(networkPolicy).toContain('tailscale.com/parent-resource: restate-admin-tailscale')
  expect(networkPolicy).toContain('port: admin')
  expect(ingress).toContain('restate.ide-newton.ts.net')
  expect(ingress).toContain('name: admin')
  expect(service).toContain('port: 9070')
})
