import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)

test('Bilig PostgreSQL retains recovered storage headroom and bounds logical-slot WAL', () => {
  const cluster = readFileSync(new URL('argocd/applications/bilig/postgres-cluster.yaml', repoRoot), 'utf8')

  expect(cluster).toContain('storageClass: rook-ceph-block\n    size: 30Gi\n    resizeInUseVolumes: true')
  expect(cluster).toContain('max_slot_wal_keep_size: 8GB')
})
