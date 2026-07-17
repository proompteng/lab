import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

const collectYamlFiles = (path: string): string[] => {
  const absolutePath = join(repoRoot, path)
  const stat = statSync(absolutePath)
  if (stat.isFile()) {
    return /\.(ya?ml)$/.test(path) ? [path] : []
  }
  return readdirSync(absolutePath).flatMap((entry) => collectYamlFiles(join(path, entry)))
}

describe('Torghut manifest scheduling', () => {
  it('uses PATH-resolved Python entrypoints for Nix-built Torghut images', () => {
    const manifestPaths = [
      ...collectYamlFiles('argocd/applications/torghut'),
      ...collectYamlFiles('argocd/applications/torghut-hyperliquid-runtime'),
    ]

    for (const path of manifestPaths) {
      const manifest = readFileSync(join(repoRoot, path), 'utf8')
      expect(manifest, path).not.toContain('/opt/venv/bin/')
    }
  })

  it('caps revision history for high-churn Torghut deployments', () => {
    const deploymentPaths = [
      'argocd/applications/symphony-torghut/deployment.patch.yaml',
      'argocd/applications/torghut-hyperliquid-feed/deployment.yaml',
      'argocd/applications/torghut-hyperliquid-runtime/deployment.yaml',
      'argocd/applications/torghut-options/archive/deployment.yaml',
      'argocd/applications/torghut-options/catalog/deployment.yaml',
      'argocd/applications/torghut-options/enricher/deployment.yaml',
      'argocd/applications/torghut/ws/deployment.yaml',
      'argocd/applications/torghut-options/ws/deployment.yaml',
    ]

    for (const path of deploymentPaths) {
      const deployment = parseManifest(path)
      expect(getAtPath(deployment, ['spec']).revisionHistoryLimit, path).toBe(2)
    }
  })

  it('rolls the options enricher without overlapping side-effecting workers', () => {
    const deployment = parseManifest('argocd/applications/torghut-options/enricher/deployment.yaml')
    expect(getAtPath(deployment, ['spec']).strategy).toMatchObject({
      type: 'RollingUpdate',
      rollingUpdate: {
        maxSurge: 0,
        maxUnavailable: 1,
      },
    })
  })

  it('runs exactly one fenced options archive worker for production proof', () => {
    const deployment = parseManifest('argocd/applications/torghut-options/archive/deployment.yaml')
    const spec = getAtPath(deployment, ['spec'])
    const podSpec = getAtPath(deployment, ['spec', 'template', 'spec'])

    expect(spec.replicas).toBe(1)
    expect(spec.strategy).toMatchObject({ type: 'Recreate' })
    expect(podSpec.nodeSelector).toMatchObject({ 'kubernetes.io/arch': 'arm64' })
    expect(podSpec.serviceAccountName).toBe('torghut-runtime')
    expect(getAtPath(deployment, ['spec', 'template', 'spec', 'containers', 0]).name).toBe('torghut-options-archive')
  })

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
      'argocd/applications/torghut/generated-resource-retention-cronjob.yaml',
      'argocd/applications/torghut/broker-economic-ledger-reconciliation-cronjob.yaml',
      'argocd/applications/torghut/order-lineage-reconciliation-cronjob.yaml',
    ]

    let checkedCronJobs = 0
    for (const path of cronJobPaths) {
      for (const manifest of parseManifestDocuments(path)) {
        expect(manifest.kind, path).toBe('CronJob')
        expect(getAtPath(manifest, ['metadata', 'labels']), path).toMatchObject({
          'app.kubernetes.io/name': 'torghut',
        })
        const spec = getAtPath(manifest, ['spec'])
        const jobSpec = getAtPath(manifest, ['spec', 'jobTemplate', 'spec'])
        expect(spec.failedJobsHistoryLimit, path).toBeGreaterThanOrEqual(2)
        expect(jobSpec.ttlSecondsAfterFinished, path).toBe(86400)
        expect(typeof jobSpec.backoffLimit, path).toBe('number')
        expect(jobSpec.backoffLimit, path).toBeGreaterThanOrEqual(0)
        expect(jobSpec.activeDeadlineSeconds, path).toBeGreaterThan(0)
        checkedCronJobs += 1
      }
    }
    expect(checkedCronJobs).toBe(3)

    const kustomization = parseManifest('argocd/applications/torghut/kustomization.yaml')
    const resources = kustomization.resources
    expect(Array.isArray(resources)).toBe(true)
    expect(resources).not.toContain('tigerbeetle-journal-order-events-cronjob.yaml')
    expect(resources).not.toContain('zero-notional-drift-repair-cronjob.yaml')
    expect(resources).not.toContain('whitepaper-autoresearch-replay-materialization-cronworkflow.yaml')
  })

  it('protects the CNPG-managed Torghut CA secret from Argo prune without creating it', () => {
    const kustomization = parseManifest('argocd/applications/torghut/kustomization.yaml')
    const resources = kustomization.resources
    expect(Array.isArray(resources)).toBe(true)
    expect(resources).toContain('torghut-db-ca-prune-tombstone.yaml')
    expect(resources).toContain('torghut-db-ca-reflector-rbac.yaml')
    expect(resources).toContain('torghut-db-ca-prune-guard-job.yaml')
    expect(resources).toContain('torghut-db-ca-reflector-job.yaml')
    expect(resources).not.toContain('torghut-db-ca-reflector-source.yaml')

    const tombstone = parseManifest('argocd/applications/torghut/torghut-db-ca-prune-tombstone.yaml')
    expect(tombstone.kind).toBe('Secret')
    expect(getAtPath(tombstone, ['metadata']).name).toBe('torghut-db-ca')
    expect(getAtPath(tombstone, ['metadata', 'annotations'])).toMatchObject({
      'argocd.argoproj.io/hook': 'Skip',
      'argocd.argoproj.io/sync-options': 'Prune=false,Delete=false',
      'argocd.argoproj.io/compare-options': 'IgnoreExtraneous',
    })
    expect('data' in tombstone).toBe(false)
    expect('stringData' in tombstone).toBe(false)

    for (const path of collectYamlFiles('argocd/applications/torghut')) {
      for (const manifest of parseManifestDocuments(path)) {
        if (!manifest) {
          continue
        }
        if (manifest.kind === 'Secret' && getAtPath(manifest, ['metadata']).name === 'torghut-db-ca') {
          expect(getAtPath(manifest, ['metadata', 'annotations'])['argocd.argoproj.io/hook'], path).toBe('Skip')
          expect('data' in manifest, path).toBe(false)
          expect('stringData' in manifest, path).toBe(false)
        }
      }
    }

    const rbac = parseManifestDocuments('argocd/applications/torghut/torghut-db-ca-reflector-rbac.yaml')
    for (const manifest of rbac) {
      expect(getAtPath(manifest, ['metadata', 'annotations'])['argocd.argoproj.io/sync-wave']).toBe('-20')
    }
    const role = rbac.find((manifest) => manifest.kind === 'Role')
    expect(role).toBeDefined()
    expect(getAtPath(role, ['rules', 0])).toMatchObject({
      apiGroups: [''],
      resources: ['secrets'],
      resourceNames: ['torghut-db-ca'],
      verbs: ['get', 'patch'],
    })

    const pruneGuard = parseManifest('argocd/applications/torghut/torghut-db-ca-prune-guard-job.yaml')
    expect(getAtPath(pruneGuard, ['metadata', 'annotations'])).toMatchObject({
      'argocd.argoproj.io/hook': 'Sync',
      'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation,HookSucceeded',
      'argocd.argoproj.io/sync-wave': '-10',
    })
    expect(getAtPath(pruneGuard, ['spec'])).toMatchObject({
      backoffLimit: 2,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 300,
    })
    expect(getAtPath(pruneGuard, ['spec', 'template', 'spec']).serviceAccountName).toBe('torghut-db-ca-reflector')
    const pruneCommand = String(getAtPath(pruneGuard, ['spec', 'template', 'spec', 'containers', 0]).command)
    expect(pruneCommand).toContain('argocd.argoproj.io/sync-options=Prune=false')
    expect(pruneCommand).toContain('argocd.argoproj.io/tracking-id-')
    expect(pruneCommand).toContain('existing torghut-db-ca lacks CNPG CA data; leaving it pruneable')
    expect(pruneCommand).toContain('protected existing CNPG-managed torghut-db-ca from Argo prune')

    const reflector = parseManifest('argocd/applications/torghut/torghut-db-ca-reflector-job.yaml')
    const reflectorCommand = String(getAtPath(reflector, ['spec', 'template', 'spec', 'containers', 0]).command)
    expect(reflectorCommand).toContain('argocd.argoproj.io/sync-options=Prune=false')
    expect(reflectorCommand).toContain('argocd.argoproj.io/tracking-id-')
    expect(reflectorCommand).toContain('reflector.v1.k8s.emberstack.com/reflection-allowed=true')
  })

  it('bounds Hyperliquid ClickHouse schema hooks so Argo syncs cannot hang on distributed DDL', () => {
    const job = parseManifest('argocd/applications/torghut-hyperliquid-feed/clickhouse-schema-job.yaml')
    const container = getAtPath(job, ['spec', 'template', 'spec', 'containers', 0])
    const args = Array.isArray(container.args) ? container.args.join('\n') : ''

    expect(getAtPath(job, ['spec']).backoffLimit).toBe(0)
    expect(getAtPath(job, ['spec']).activeDeadlineSeconds).toBe(240)
    expect(getAtPath(job, ['spec', 'template', 'spec']).restartPolicy).toBe('Never')
    expect(args).toContain('set -euo pipefail')
    expect(args).toContain('--connect_timeout 5')
    expect(args).toContain('--send_timeout 30')
    expect(args).toContain('--receive_timeout 60')
    expect(args).toContain("SELECT DISTINCT host_name FROM system.clusters WHERE cluster='default' ORDER BY host_name")
    expect(args).toContain("sed -E 's/ ON CLUSTER default//g' /schema/schema.sql > /tmp/schema-local.sql")
    expect(args).toContain(
      'timeout 90s "${CLICKHOUSE_CLIENT[@]}" --host "${host}" --multiquery < /tmp/schema-local.sql',
    )
    expect(args).toContain('ClickHouse host ${host} has ${count}/${#REQUIRED_TABLES[@]} required Hyperliquid tables')

    const schema = parseManifest('argocd/applications/torghut-hyperliquid-feed/clickhouse-schema-configmap.yaml')
    const data = getAtPath(schema, ['data'])
    expect(data['schema.sql']).toContain('SET distributed_ddl_task_timeout = 10;')
    expect(data['schema.sql']).toContain("SET distributed_ddl_output_mode = 'null_status_on_timeout';")
    for (const table of [
      'hyperliquid_raw',
      'hyperliquid_market_catalog',
      'hyperliquid_trades',
      'hyperliquid_l2_books',
      'hyperliquid_bbo',
      'hyperliquid_candles',
      'hyperliquid_asset_contexts',
      'hyperliquid_funding',
      'hyperliquid_status',
    ]) {
      expect(data['schema.sql']).not.toContain(`CREATE TABLE IF NOT EXISTS torghut.${table}_kafka_staging`)
      expect(data['schema.sql']).toContain(
        `DROP TABLE IF EXISTS torghut.${table}_kafka_staging ON CLUSTER default SYNC;`,
      )
      expect(data['schema.sql']).toContain(`ALTER TABLE torghut.${table} ON CLUSTER default`)
    }
    for (const column of ['kafka_topic', 'kafka_partition', 'kafka_offset']) {
      expect(data['schema.sql'].match(new RegExp(`DROP COLUMN IF EXISTS ${column}`, 'g'))).toHaveLength(9)
    }
    expect(args).toContain('removed_table_count')
    expect(args).toContain('legacy_column_count')
    expect(args).toContain('still has ${removed_count} removed Hyperliquid staging tables')
    expect(args).toContain('still has ${column_count} removed Hyperliquid Kafka-lineage columns')
    expect(args).not.toContain('WRITER_TABLES')
  })

  it('bounds Torghut PostSync hook jobs so completed hooks do not become residue', () => {
    const checks = [
      {
        path: 'argocd/applications/torghut/tigerbeetle-smoke-job.yaml',
        ttlSecondsAfterFinished: 600,
        backoffLimit: 3,
        activeDeadlineSeconds: 300,
      },
      {
        path: 'argocd/applications/torghut/whitepapers-bucket-bootstrap-job.yaml',
        ttlSecondsAfterFinished: 300,
        backoffLimit: 2,
        activeDeadlineSeconds: 120,
      },
    ]

    for (const check of checks) {
      const manifest = parseManifest(check.path)
      const spec = getAtPath(manifest, ['spec'])
      const annotations = getAtPath(manifest, ['metadata', 'annotations'])

      expect(annotations['argocd.argoproj.io/hook'], check.path).toBe('PostSync')
      expect(annotations['argocd.argoproj.io/hook-delete-policy'], check.path).toBe('BeforeHookCreation,HookSucceeded')
      expect(spec.ttlSecondsAfterFinished, check.path).toBe(check.ttlSecondsAfterFinished)
      expect(spec.backoffLimit, check.path).toBe(check.backoffLimit)
      expect(spec.activeDeadlineSeconds, check.path).toBe(check.activeDeadlineSeconds)
    }
  })

  it('bounds Hyperliquid live ClickHouse writes to the readiness-critical feed path', () => {
    const config = parseManifest('argocd/applications/torghut-hyperliquid-feed/configmap.yaml')
    const data = getAtPath(config, ['data'])
    const enabledTables = String(data.CLICKHOUSE_ENABLED_TABLES).split(',')
    const readyTables = String(data.CLICKHOUSE_READY_TABLES).split(',')

    expect(enabledTables).toEqual([
      'hyperliquid_market_catalog',
      'hyperliquid_bbo',
      'hyperliquid_candles',
      'hyperliquid_asset_contexts',
      'hyperliquid_funding',
      'hyperliquid_status',
    ])
    expect(readyTables).toEqual(['hyperliquid_bbo', 'hyperliquid_candles'])
    expect(readyTables.every((table) => enabledTables.includes(table))).toBe(true)
    expect(data.CLICKHOUSE_REQUEST_TIMEOUT_MS).toBe('30000')
    expect(data.CLICKHOUSE_ENABLED).toBe('true')
    expect(data.CLICKHOUSE_REQUIRED_FOR_READINESS).toBe('true')
    expect(data.KAFKA_READY_MAX_AGE_MS).toBe('120000')
    expect(data.CLICKHOUSE_READY_MAX_AGE_MS).toBe('300000')
    expect(data.CLICKHOUSE_TABLE_READY_MAX_AGE_MS).toBe('300000')
    expect(Object.keys(data).some((key) => key.startsWith('CLICKHOUSE_WRITER_'))).toBe(false)
    expect(Object.keys(data).some((key) => key.startsWith('CLICKHOUSE_PARITY_'))).toBe(false)
    expect(data.HYPERLIQUID_TOP_MARKET_COUNT).toBe('12')
    expect(data.HYPERLIQUID_PINNED_PERP_COINS).toBe('BTC,ETH,HYPE,SOL,SKHX,MU,XYZ100,CL,SNDK,MSTR,SILVER,GOLD')

    const deployment = parseManifest('argocd/applications/torghut-hyperliquid-feed/deployment.yaml')
    const feedContainer = getAtPath(deployment, ['spec', 'template', 'spec', 'containers', 0])
    expect(String(feedContainer.image)).toMatch(
      /^registry\.ide-newton\.ts\.net\/lab\/torghut-hyperliquid-feed@sha256:[0-9a-f]{64}$/,
    )
    expect(String(feedContainer.image)).not.toContain(':latest')
    const feedEnv = feedContainer.env
    expect(feedEnv).toContainEqual(
      expect.objectContaining({
        name: 'TORGHUT_HYPERLIQUID_FEED_COMMIT',
        value: expect.stringMatching(/^[0-9a-f]{40}$/),
      }),
    )
    expect(feedEnv).toContainEqual(
      expect.objectContaining({
        name: 'TORGHUT_HYPERLIQUID_FEED_IMAGE_DIGEST',
        value: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    )
    expect(feedEnv).toContainEqual(
      expect.objectContaining({
        name: 'HYPERLIQUID_PINNED_PERP_COINS',
        value: 'BTC,ETH,HYPE,SOL,SKHX,MU,XYZ100,CL,SNDK,MSTR,SILVER,GOLD',
      }),
    )
    expect(
      getAtPath(deployment, ['spec', 'template', 'metadata', 'annotations'])['proompteng.ai/config-revision'],
    ).toBe('hyperliquid-feed-pinned-runtime-universe-20260704a')
  })

  it('bounds Hyperliquid runtime ClickHouse schema hooks so Argo syncs cannot hang on distributed DDL', () => {
    const job = parseManifest('argocd/applications/torghut-hyperliquid-runtime/clickhouse-schema-job.yaml')
    const container = getAtPath(job, ['spec', 'template', 'spec', 'containers', 0])
    const args = Array.isArray(container.args) ? container.args.join('\n') : ''

    expect(getAtPath(job, ['spec']).backoffLimit).toBe(0)
    expect(getAtPath(job, ['spec']).activeDeadlineSeconds).toBe(240)
    expect(getAtPath(job, ['spec', 'template', 'spec']).restartPolicy).toBe('Never')
    expect(args).toContain('set -euo pipefail')
    expect(args).toContain('--connect_timeout 5')
    expect(args).toContain('--send_timeout 30')
    expect(args).toContain('--receive_timeout 60')
    expect(args).toContain("SELECT DISTINCT host_name FROM system.clusters WHERE cluster='default' ORDER BY host_name")
    expect(args).toContain("sed -E 's/ ON CLUSTER default//g' /schema/schema.sql > /tmp/schema-local.sql")
    expect(args).toContain(
      'timeout 90s "${CLICKHOUSE_CLIENT[@]}" --host "${host}" --multiquery < /tmp/schema-local.sql',
    )
    expect(args).toContain(
      'ClickHouse host ${host} has ${count}/${#REQUIRED_OBJECTS[@]} required Hyperliquid runtime objects',
    )

    const schema = parseManifest('argocd/applications/torghut-hyperliquid-runtime/clickhouse-schema-configmap.yaml')
    const data = getAtPath(schema, ['data'])
    expect(data['schema.sql']).toContain('SET distributed_ddl_task_timeout = 10;')
    expect(data['schema.sql']).toContain("SET distributed_ddl_output_mode = 'null_status_on_timeout';")
    expect(data['schema.sql']).toContain(
      "greatest(0, dateDiff('second', b.quote_ingest_ts, now64(3))) AS quote_lag_seconds",
    )
    expect(data['schema.sql']).toContain('parseDateTimeBestEffort(ingest_ts)')
    expect(data['schema.sql']).toContain('AS quote_ingest_ts')
    expect(data['schema.sql']).toContain('AND parseDateTimeBestEffort(ingest_ts) >= now() - INTERVAL 2 HOUR')
    expect(data['schema.sql']).not.toContain('INSERT INTO torghut.hyperliquid_ta_features')
  })

  it('runs the Hyperliquid v2 hard-reset runtime with profitability-gated testnet entries frozen', () => {
    const runtimeConfig = parseManifest('argocd/applications/torghut-hyperliquid-runtime/configmap.yaml')
    const runtimeData = getAtPath(runtimeConfig, ['data'])
    expect(Object.keys(runtimeData).some((key) => key.startsWith('HYPERLIQUID_RUNTIME_'))).toBe(false)
    expect(runtimeData.HYPERLIQUID_EXECUTION_TRADING_ENABLED).toBe('false')
    expect(runtimeData.HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES).toBe('true')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK).toBe('mainnet')
    expect(runtimeData.HYPERLIQUID_EXECUTION_EXECUTION_NETWORK).toBe('testnet')
    expect(runtimeData.HYPERLIQUID_EXECUTION_TRADE_COINS).toBe(
      'BTC,ETH,HYPE,SOL,xyz:SKHX,xyz:MU,xyz:XYZ100,xyz:CL,xyz:SNDK,xyz:MSTR,xyz:SILVER,xyz:GOLD',
    )
    expect(runtimeData.HYPERLIQUID_EXECUTION_EXCLUDED_COINS).toBe('SPX')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD).toBe('12')
    expect(runtimeData.HYPERLIQUID_EXECUTION_TARGET_MARGIN_UTILIZATION).toBe('0.35')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_SYMBOL_MARGIN_UTILIZATION).toBe('0.08')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_ORDER_MARGIN_UTILIZATION).toBe('0.02')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_DAILY_LOSS_USD).toBe('100')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_ORDER_NOTIONAL_USD).toBeUndefined()
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_SYMBOL_EXPOSURE_USD).toBeUndefined()
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_GROSS_EXPOSURE_USD).toBeUndefined()
    expect(runtimeData.HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS).toBe('1000')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MIN_AFTER_COST_EDGE_BPS).toBe('4')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MIN_EDGE_COST_RATIO).toBe('2')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_SYMBOL_TURNOVER_EQUITY_MULTIPLE_1H).toBe('1')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES).toBe('300')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SIDE_FLIP).toBe('900')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED).toBe('true')
    expect(runtimeData.HYPERLIQUID_EXECUTION_ORDER_POLICY).toBe('marketable_ioc')
    expect(runtimeData.HYPERLIQUID_EXECUTION_ORDER_TTL_SECONDS).toBe('10')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAKER_TIF).toBeUndefined()
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAKER_TTL_SECONDS).toBeUndefined()
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_OPEN_ORDERS_PER_SYMBOL).toBe('1')
    expect(runtimeData.HYPERLIQUID_EXECUTION_FEED_READINESS_URL).toBe(
      'http://torghut-hyperliquid-feed.torghut.svc.cluster.local/readyz',
    )
    expect(runtimeData.HYPERLIQUID_EXECUTION_FEED_READINESS_TIMEOUT_SECONDS).toBe('3')

    const runtimeDeployment = parseManifest('argocd/applications/torghut-hyperliquid-runtime/deployment.yaml')
    expect(getAtPath(runtimeDeployment, ['spec']).replicas).toBe(1)
    expect(getAtPath(runtimeDeployment, ['spec']).revisionHistoryLimit).toBe(2)
    expect(getAtPath(runtimeDeployment, ['spec', 'template', 'metadata', 'annotations'])).toMatchObject({
      'proompteng.ai/config-revision': 'hyperliquid-testnet-loss-cap-20260705a',
    })
    const runtimeContainer = getAtPath(runtimeDeployment, ['spec', 'template', 'spec', 'containers', 0])
    expect(runtimeContainer.command).toContain('app.hyperliquid_execution.api:app')
    expect(String(runtimeContainer.image)).toMatch(/^registry\.ide-newton\.ts\.net\/lab\/torghut@sha256:[0-9a-f]{64}$/)
    expect(String(runtimeContainer.image)).not.toContain(':latest')
    expect(getAtPath(runtimeContainer, ['securityContext'])).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      seccompProfile: { type: 'Unconfined' },
    })
    const runtimeEnv = runtimeContainer.env
    expect(runtimeEnv).toContainEqual(
      expect.objectContaining({
        name: 'TORGHUT_COMMIT',
        value: expect.stringMatching(/^[0-9a-f]{40}$/),
      }),
    )
    expect(runtimeEnv).toContainEqual(
      expect.objectContaining({
        name: 'TORGHUT_IMAGE_DIGEST',
        value: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    )

    const runtimeMigrationJob = parseManifest('argocd/applications/torghut-hyperliquid-runtime/db-migrations-job.yaml')
    expect(getAtPath(runtimeMigrationJob, ['spec']).activeDeadlineSeconds).toBe(3600)
    const migrationContainer = getAtPath(runtimeMigrationJob, ['spec', 'template', 'spec', 'containers', 0])
    expect(String(migrationContainer.image)).toMatch(
      /^registry\.ide-newton\.ts\.net\/lab\/torghut@sha256:[0-9a-f]{64}$/,
    )
    expect(String(migrationContainer.image)).not.toContain(':latest')

    const kustomization = parseManifest('argocd/applications/torghut-hyperliquid-runtime/kustomization.yaml')
    const resources = kustomization.resources
    expect(resources).toBeArray()
    expect(resources).toContain('externalsecret.yaml')

    const externalSecret = parseManifest('argocd/applications/torghut-hyperliquid-runtime/externalsecret.yaml')
    expect(externalSecret.kind).toBe('ExternalSecret')
    expect(getAtPath(externalSecret, ['metadata']).name).toBe('torghut-hyperliquid-testnet')
    expect(getAtPath(externalSecret, ['metadata', 'annotations'])).toMatchObject({
      'argocd.argoproj.io/ignore-healthcheck': 'true',
    })
    expect(getAtPath(externalSecret, ['spec'])).toMatchObject({
      refreshPolicy: 'CreatedOnce',
      refreshInterval: '0s',
    })
    expect(getAtPath(externalSecret, ['spec', 'secretStoreRef'])).toMatchObject({
      kind: 'ClusterSecretStore',
      name: 'onepassword-infra',
    })
    expect(getAtPath(externalSecret, ['spec', 'target'])).toMatchObject({
      name: 'torghut-hyperliquid-testnet',
      creationPolicy: 'Owner',
      deletionPolicy: 'Retain',
    })
    const secretData = getAtPath(externalSecret, ['spec']).data
    expect(secretData).toContainEqual(
      expect.objectContaining({
        secretKey: 'account-address',
        remoteRef: expect.objectContaining({ key: 'hyperliquid-testnet/account-address' }),
      }),
    )
    expect(secretData).toContainEqual(
      expect.objectContaining({
        secretKey: 'api-wallet-private-key',
        remoteRef: expect.objectContaining({ key: 'hyperliquid-testnet/api-wallet-private-key' }),
      }),
    )
  })

  it('documents the Hyperliquid testnet credential and funding gate', () => {
    const readme = readFileSync(join(repoRoot, 'argocd/applications/torghut-hyperliquid-runtime/README.md'), 'utf8')
    const bootstrapScript = readFileSync(
      join(repoRoot, 'scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh'),
      'utf8',
    )

    expect(readme).toContain('bootstrap-hyperliquid-testnet-1password.sh status')
    expect(readme).toContain('bootstrap-hyperliquid-testnet-1password.sh check')
    expect(readme).toContain('bootstrap-hyperliquid-testnet-1password.sh create')
    expect(readme).toContain('bootstrap-hyperliquid-testnet-1password.sh reconcile')
    expect(readme).toContain('HYPERLIQUID_EXECUTION_TRADING_ENABLED=false')
    expect(readme).toContain('after-cost profitability gate')
    expect(readme).toContain('release image promotion')
    expect(readme).toContain('ORDER_POLICY=marketable_ioc')
    expect(readme).toContain('ORDER_TTL_SECONDS=10')
    expect(readme).toContain('TARGET_MARGIN_UTILIZATION=0.35')
    expect(readme).toContain('SPX')
    expect(bootstrapScript).toContain('$0 check')
    expect(bootstrapScript).toContain('check_item()')
  })

  it('keeps options TA recoverable across transient Kafka source startup failures', () => {
    const config = parseManifest('argocd/applications/torghut-options/ta/configmap.yaml')
    const data = getAtPath(config, ['data'])
    expect(data.TA_AUTO_OFFSET_RESET).toBe('latest')

    const deployment = parseManifest('argocd/applications/torghut-options/ta/flinkdeployment.yaml')
    const spec = getAtPath(deployment, ['spec'])
    const flinkConfiguration = getAtPath(spec, ['flinkConfiguration'])
    expect(spec.restartNonce).toBeGreaterThanOrEqual(16)
    expect(flinkConfiguration['restart-strategy.fixed-delay.attempts']).toBe('60')
    expect(flinkConfiguration['restart-strategy.fixed-delay.delay']).toBe('10 s')
  })

  it('bounds options archive finalization writes and rolls ConfigMap changes', () => {
    const config = parseManifest('argocd/applications/torghut-options/archive/configmap.yaml')
    const data = getAtPath(config, ['data'])
    expect(data.OPTIONS_CONTRACT_ARCHIVE_FINALIZE_BATCH_SIZE).toBe('100')
    expect(data.OPTIONS_CONTRACT_ARCHIVE_FINALIZE_INTERVAL_MS).toBe('1000')
    expect(data.OPTIONS_CONTRACT_ARCHIVE_STATEMENT_TIMEOUT_MS).toBe('30000')

    const deployment = parseManifest('argocd/applications/torghut-options/archive/deployment.yaml')
    expect(getAtPath(deployment, ['spec', 'template', 'metadata', 'annotations'])).toMatchObject({
      'proompteng.ai/config-revision': 'archive-overlay-write-budget-20260714a',
    })
  })

  it('keeps production TA in live consumer mode', () => {
    const config = parseManifest('argocd/applications/torghut/ta/configmap.yaml')
    const data = getAtPath(config, ['data'])
    expect(data.TA_GROUP_ID).toBe('torghut-ta-live')
    expect(String(data.TA_GROUP_ID)).not.toContain('replay')
    expect(data.TA_AUTO_OFFSET_RESET).toBe('latest')

    const deployment = parseManifest('argocd/applications/torghut/ta/flinkdeployment.yaml')
    const spec = getAtPath(deployment, ['spec'])
    expect(spec.restartNonce).toBeGreaterThanOrEqual(20)
  })

  it('configures 2026 US market holidays for Torghut market-data freshness gates', () => {
    const expectedHolidays =
      '2026-01-01,2026-01-19,2026-02-16,2026-04-03,2026-05-25,2026-06-19,2026-07-03,2026-09-07,2026-11-26,2026-12-25'

    for (const path of [
      'argocd/applications/torghut/ws/configmap.yaml',
      'argocd/applications/torghut-options/ws/configmap.yaml',
    ]) {
      const config = parseManifest(path)
      expect(getAtPath(config, ['data']).OPTIONS_MARKET_HOLIDAYS, path).toBe(expectedHolidays)
    }
  })
})
