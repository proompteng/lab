import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Jangar base backups cannot saturate the shared Ceph path', () => {
  const cluster = readRepoFile('argocd/applications/jangar/postgres-cluster.yaml')

  expect(cluster).toContain('target: prefer-standby')
  expect(cluster).toContain('data:\n        compression: snappy\n        jobs: 1')
  expect(cluster).toContain('additionalCommandArgs:\n          - --max-bandwidth\n          - 8MB')
  expect(cluster).toContain('wal:\n        compression: snappy\n        maxParallel: 2')
})

test('Jangar database volumes retain operating headroom', () => {
  const cluster = readRepoFile('argocd/applications/jangar/postgres-cluster.yaml')

  expect(cluster).toContain('storageClass: rook-ceph-block\n    size: 300Gi')
})

test('Jangar backup has an isolated start window after the Torghut backup', () => {
  const scheduledBackup = readRepoFile('argocd/applications/jangar/postgres-scheduled-backup.yaml')

  expect(scheduledBackup).toContain('schedule: "0 0 4 * * *"')
})
