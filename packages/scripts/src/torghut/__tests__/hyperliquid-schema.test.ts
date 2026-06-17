import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ConfigMapManifest = {
  data?: Record<string, string>
}

const schemaManifestPath = 'argocd/applications/torghut-hyperliquid-feed/clickhouse-schema-configmap.yaml'

const readSchemaSql = (): string => {
  const manifest = YAML.parse(readFileSync(join(repoRoot, schemaManifestPath), 'utf8')) as ConfigMapManifest
  const schemaSql = manifest.data?.['schema.sql']
  if (typeof schemaSql !== 'string') {
    throw new Error(`Missing schema.sql in ${schemaManifestPath}`)
  }
  return schemaSql
}

describe('Torghut Hyperliquid ClickHouse schema', () => {
  it('uses a ClickHouse-compatible ReplacingMergeTree version column', () => {
    const schemaSql = readSchemaSql()
    const engines = schemaSql.match(/ReplicatedReplacingMergeTree\([^)]+\)/g) ?? []

    expect(engines.length).toBe(9)
    expect(schemaSql).toContain('version UInt32')

    for (const engine of engines) {
      expect(engine).toContain(', version)')
      expect(engine).not.toContain(', ingest_ts)')
    }
  })
})
