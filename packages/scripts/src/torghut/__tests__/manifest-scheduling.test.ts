import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type JsonRecord = Record<string, unknown>

type ManifestCheck = {
  path: string
  selectorPath: Array<string | number>
}

const torghutArm64ImageChecks: ManifestCheck[] = [
  { path: 'argocd/applications/torghut/knative-service.yaml', selectorPath: ['spec', 'template', 'spec'] },
  { path: 'argocd/applications/torghut/knative-service-sim.yaml', selectorPath: ['spec', 'template', 'spec'] },
  { path: 'argocd/applications/torghut/db-migrations-job.yaml', selectorPath: ['spec', 'template', 'spec'] },
  { path: 'argocd/applications/torghut/empirical-jobs-backfill-job.yaml', selectorPath: ['spec', 'template', 'spec'] },
  {
    path: 'argocd/applications/torghut/analysis-template-runtime-ready.yaml',
    selectorPath: ['spec', 'metrics', 0, 'provider', 'job', 'spec', 'template', 'spec'],
  },
  {
    path: 'argocd/applications/torghut/analysis-template-activity.yaml',
    selectorPath: ['spec', 'metrics', 0, 'provider', 'job', 'spec', 'template', 'spec'],
  },
  {
    path: 'argocd/applications/torghut/analysis-template-teardown-clean.yaml',
    selectorPath: ['spec', 'metrics', 0, 'provider', 'job', 'spec', 'template', 'spec'],
  },
  {
    path: 'argocd/applications/torghut/analysis-template-artifact-bundle.yaml',
    selectorPath: ['spec', 'metrics', 0, 'provider', 'job', 'spec', 'template', 'spec'],
  },
  {
    path: 'argocd/applications/torghut/historical-simulation-workflowtemplate.yaml',
    selectorPath: ['spec', 'templates', 0],
  },
  {
    path: 'argocd/applications/torghut/empirical-promotion-workflowtemplate.yaml',
    selectorPath: ['spec', 'templates', 0],
  },
  {
    path: 'argocd/applications/torghut/whitepaper-autoresearch-workflowtemplate.yaml',
    selectorPath: ['spec', 'templates', 0],
  },
]

const getAtPath = (root: unknown, selectorPath: Array<string | number>): JsonRecord => {
  let value = root
  for (const segment of selectorPath) {
    if (typeof value !== 'object' || value === null || !(segment in value)) {
      throw new Error(`Missing manifest selector path segment ${String(segment)}`)
    }
    value = (value as Record<string | number, unknown>)[segment]
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Manifest selector path did not resolve to an object')
  }
  return value as JsonRecord
}

const parseManifest = (path: string): JsonRecord => YAML.parse(readFileSync(join(repoRoot, path), 'utf8')) as JsonRecord

const parseManifestDocuments = (path: string): JsonRecord[] =>
  YAML.parseAllDocuments(readFileSync(join(repoRoot, path), 'utf8')).map((document) => document.toJSON() as JsonRecord)

const parameterValue = (manifest: JsonRecord, name: string): string => {
  const parameters = getAtPath(manifest, ['spec', 'arguments']).parameters
  if (!Array.isArray(parameters)) {
    throw new Error('Manifest arguments.parameters is not an array')
  }
  const parameter = parameters.find((item) => typeof item === 'object' && item !== null && item.name === name) as
    | { value?: unknown }
    | undefined
  if (typeof parameter?.value !== 'string') {
    throw new Error(`Missing string parameter ${name}`)
  }
  return parameter.value
}

describe('Torghut manifest scheduling', () => {
  it('pins arm64-only Torghut image consumers to arm64 nodes', () => {
    for (const check of torghutArm64ImageChecks) {
      const manifest = parseManifest(check.path)
      const podSpec = getAtPath(manifest, check.selectorPath)
      expect(podSpec.nodeSelector, check.path).toMatchObject({
        'kubernetes.io/arch': 'arm64',
      })
    }
  })

  it('retains Torghut scheduled failure logs for same-day debugging', () => {
    const cronJobPaths = [
      'argocd/applications/torghut/empirical-artifacts-retention-cronjob.yaml',
      'argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml',
      'argocd/applications/torghut/execution-tca-refresh-cronjob.yaml',
      'argocd/applications/torghut/zero-notional-drift-repair-cronjob.yaml',
      'argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml',
      'argocd/applications/torghut/paper-account-flatten-cronjob.yaml',
    ]

    let checkedCronJobs = 0
    for (const path of cronJobPaths) {
      for (const manifest of parseManifestDocuments(path)) {
        expect(manifest.kind, path).toBe('CronJob')
        const spec = getAtPath(manifest, ['spec'])
        const jobSpec = getAtPath(manifest, ['spec', 'jobTemplate', 'spec'])
        expect(spec.failedJobsHistoryLimit, path).toBe(2)
        expect(jobSpec.ttlSecondsAfterFinished, path).toBe(86400)
        checkedCronJobs += 1
      }
    }
    expect(checkedCronJobs).toBe(6)

    const replayCronWorkflow = parseManifest(
      'argocd/applications/torghut/whitepaper-autoresearch-replay-materialization-cronworkflow.yaml',
    )
    expect(replayCronWorkflow.kind).toBe('CronWorkflow')
    expect(getAtPath(replayCronWorkflow, ['spec']).failedJobsHistoryLimit).toBe(0)
  })

  it('bounds Hyperliquid ClickHouse schema hooks so Argo syncs cannot hang on distributed DDL', () => {
    const job = parseManifest('argocd/applications/torghut-hyperliquid-feed/clickhouse-schema-job.yaml')
    const container = getAtPath(job, ['spec', 'template', 'spec', 'containers', 0])
    const args = Array.isArray(container.args) ? container.args.join('\n') : ''

    expect(getAtPath(job, ['spec']).activeDeadlineSeconds).toBe(900)
    expect(args).toContain('set -euo pipefail')
    expect(args).toContain('--connect_timeout 5')
    expect(args).toContain('--send_timeout 30')
    expect(args).toContain('--receive_timeout 120')
    expect(args).toContain('"${CLICKHOUSE_CLIENT[@]}" --multiquery < /schema/schema.sql')

    const schema = parseManifest('argocd/applications/torghut-hyperliquid-feed/clickhouse-schema-configmap.yaml')
    const data = getAtPath(schema, ['data'])
    expect(data['schema.sql']).toContain('SET distributed_ddl_task_timeout = 45;')
    expect(data['schema.sql']).toContain("SET distributed_ddl_output_mode = 'null_status_on_timeout';")
  })

  it('keeps Hyperliquid ClickHouse persistence enabled for the full public feed history', () => {
    const config = parseManifest('argocd/applications/torghut-hyperliquid-feed/configmap.yaml')
    const data = getAtPath(config, ['data'])
    const enabledTables = String(data.CLICKHOUSE_ENABLED_TABLES).split(',')
    const readyTables = String(data.CLICKHOUSE_READY_TABLES).split(',')

    expect(enabledTables).toEqual([
      'hyperliquid_raw',
      'hyperliquid_market_catalog',
      'hyperliquid_trades',
      'hyperliquid_l2_books',
      'hyperliquid_bbo',
      'hyperliquid_candles',
      'hyperliquid_asset_contexts',
      'hyperliquid_funding',
      'hyperliquid_status',
    ])
    expect(readyTables).toEqual([
      'hyperliquid_raw',
      'hyperliquid_trades',
      'hyperliquid_l2_books',
      'hyperliquid_bbo',
      'hyperliquid_candles',
      'hyperliquid_asset_contexts',
    ])
    expect(readyTables.every((table) => enabledTables.includes(table))).toBe(true)

    const deployment = parseManifest('argocd/applications/torghut-hyperliquid-feed/deployment.yaml')
    expect(
      getAtPath(deployment, ['spec', 'template', 'metadata', 'annotations'])['proompteng.ai/config-revision'],
    ).toBe('hyperliquid-feed-full-clickhouse-20260618c')
  })

  it('keeps Hyperliquid runtime shadow mode free of optional execution secret drift', () => {
    const runtimeConfig = parseManifest('argocd/applications/torghut-hyperliquid-runtime/configmap.yaml')
    const runtimeData = getAtPath(runtimeConfig, ['data'])
    expect(runtimeData.HYPERLIQUID_RUNTIME_TRADING_ENABLED).toBe('false')

    const kustomization = parseManifest('argocd/applications/torghut-hyperliquid-runtime/kustomization.yaml')
    const resources = kustomization.resources
    expect(resources).toBeArray()
    expect(resources).not.toContain('externalsecret.yaml')
  })

  it('keeps options TA recoverable across transient Kafka source startup failures', () => {
    const config = parseManifest('argocd/applications/torghut-options/ta/configmap.yaml')
    const data = getAtPath(config, ['data'])
    expect(data.TA_AUTO_OFFSET_RESET).toBe('latest')

    const deployment = parseManifest('argocd/applications/torghut-options/ta/flinkdeployment.yaml')
    const spec = getAtPath(deployment, ['spec'])
    const flinkConfiguration = getAtPath(spec, ['flinkConfiguration'])
    expect(spec.restartNonce).toBe(15)
    expect(flinkConfiguration['restart-strategy.fixed-delay.attempts']).toBe('60')
    expect(flinkConfiguration['restart-strategy.fixed-delay.delay']).toBe('10 s')
  })

  it('keeps whitepaper autoresearch off the serving pod resource envelope', () => {
    const manifest = parseManifest('argocd/applications/torghut/whitepaper-autoresearch-workflowtemplate.yaml')
    const template = getAtPath(manifest, ['spec', 'templates', 0])
    const container = getAtPath(template, ['container'])
    const resources = getAtPath(container, ['resources'])
    const requests = getAtPath(resources, ['requests'])
    const limits = getAtPath(resources, ['limits'])

    expect(requests.memory).toBe('12Gi')
    expect(limits.memory).toBe('32Gi')
    expect(container.volumeMounts).toContainEqual(
      expect.objectContaining({
        mountPath: '/etc/torghut',
        name: 'strategy-config',
      }),
    )
    expect(JSON.stringify(template)).toContain('run_whitepaper_autoresearch_profit_target.py')
    expect(parameterValue(manifest, 'targetNetPnlPerDay')).toBe('500')
    expect(JSON.stringify(template)).toContain(
      'config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml',
    )
    expect(JSON.stringify(template)).not.toContain(
      'config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml',
    )
    expect(JSON.stringify(template)).toContain('--real-replay-shard-size')
    expect(JSON.stringify(template)).toContain('--real-replay-shard-timeout-seconds')
    expect(JSON.stringify(template)).toContain('--real-replay-shard-workers')
    expect(JSON.stringify(template)).toContain('--feedback-block-reaudit-slots')
    expect(JSON.stringify(template)).toContain('--selection-only')
    expect(parameterValue(manifest, 'maxCandidates')).toBe('128')
    expect(parameterValue(manifest, 'topK')).toBe('64')
    expect(parameterValue(manifest, 'explorationSlots')).toBe('48')
    expect(parameterValue(manifest, 'feedbackBlockReauditSlots')).toBe('32')
    expect(parameterValue(manifest, 'portfolioSizeMin')).toBe('3')
    expect(parameterValue(manifest, 'selectionOnly')).toBe('false')
  })

  it('bounds whitepaper autoresearch real replay so profit runs emit evidence before timeout', () => {
    const manifest = parseManifest('argocd/applications/torghut/whitepaper-autoresearch-workflowtemplate.yaml')
    const template = getAtPath(manifest, ['spec', 'templates', 0])

    expect(parameterValue(manifest, 'maxFrontierCandidatesPerSpec')).toBe('2')
    expect(parameterValue(manifest, 'maxTotalFrontierCandidates')).toBe('128')
    expect(parameterValue(manifest, 'realReplayTimeoutSeconds')).toBe('7200')
    expect(parameterValue(manifest, 'realReplayShardSize')).toBe('1')
    expect(parameterValue(manifest, 'realReplayShardWorkers')).toBe('4')
    expect(template.activeDeadlineSeconds).toBe(9000)
  })
})
