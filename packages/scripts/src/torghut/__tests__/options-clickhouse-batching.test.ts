import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ConfigMap = {
  data: Record<string, string>
}

type FlinkDeployment = {
  spec: {
    restartNonce: number
  }
}

const config = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/torghut-options/ta/configmap.yaml'), 'utf8'),
) as ConfigMap
const deployment = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/torghut-options/ta/flinkdeployment.yaml'), 'utf8'),
) as FlinkDeployment

describe('Torghut options ClickHouse batching', () => {
  it('batches at the ClickHouse production minimum with one writer', () => {
    expect(Number(config.data.OPTIONS_TA_CLICKHOUSE_BATCH_SIZE)).toBeGreaterThanOrEqual(1_000)
    expect(config.data.OPTIONS_TA_CLICKHOUSE_SINK_PARALLELISM).toBe('1')
  })

  it('keeps the bounded flush below the ClickHouse freshness SLO', () => {
    const flushMs = Number(config.data.OPTIONS_TA_CLICKHOUSE_FLUSH_MS)
    const freshnessSloMs = Number(config.data.OPTIONS_SLO_CLICKHOUSE_FRESHNESS_SEC) * 1_000

    expect(flushMs).toBe(30_000)
    expect(flushMs).toBeLessThan(freshnessSloMs)
  })

  it('keeps legacy fallbacks aligned and forces the Flink rollout', () => {
    expect(config.data.TA_CLICKHOUSE_BATCH_SIZE).toBe(config.data.OPTIONS_TA_CLICKHOUSE_BATCH_SIZE)
    expect(config.data.TA_CLICKHOUSE_FLUSH_MS).toBe(config.data.OPTIONS_TA_CLICKHOUSE_FLUSH_MS)
    expect(config.data.TA_CLICKHOUSE_SINK_PARALLELISM).toBe(config.data.OPTIONS_TA_CLICKHOUSE_SINK_PARALLELISM)
    expect(deployment.spec.restartNonce).toBeGreaterThan(30)
  })
})
