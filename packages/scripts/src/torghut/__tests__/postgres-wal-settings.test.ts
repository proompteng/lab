import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type PostgresCluster = {
  spec: {
    postgresql: {
      parameters: Record<string, string>
    }
  }
}

const cluster = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/torghut/postgres-cluster.yaml'), 'utf8'),
) as PostgresCluster

describe('Torghut PostgreSQL WAL settings', () => {
  it('uses a bounded WAL buffer sized for observed production bursts', () => {
    expect(cluster.spec.postgresql.parameters.wal_buffers).toBe('16MB')
  })

  it('does not weaken PostgreSQL durability', () => {
    const parameters = cluster.spec.postgresql.parameters

    expect(parameters.fsync).not.toBe('off')
    expect(parameters.full_page_writes).not.toBe('off')
    expect(parameters.synchronous_commit).not.toBe('off')
  })
})
