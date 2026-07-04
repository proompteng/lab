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

describe('Torghut manifest scheduling', () => {
  it('caps revision history for high-churn Torghut deployments', () => {
    const deploymentPaths = [
      'argocd/applications/symphony-torghut/deployment.patch.yaml',
      'argocd/applications/torghut-hyperliquid-feed/deployment.yaml',
      'argocd/applications/torghut-hyperliquid-runtime/deployment.yaml',
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
      'argocd/applications/torghut/zero-notional-drift-repair-cronjob.yaml',
      'argocd/applications/torghut/paper-account-flatten-cronjob.yaml',
      'argocd/applications/torghut/generated-resource-retention-cronjob.yaml',
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
        expect(spec.failedJobsHistoryLimit, path).toBe(2)
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
    expect(resources).not.toContain('whitepaper-autoresearch-replay-materialization-cronworkflow.yaml')
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

  it('runs the Hyperliquid v2 hard-reset runtime with capped testnet trading enabled', () => {
    const runtimeConfig = parseManifest('argocd/applications/torghut-hyperliquid-runtime/configmap.yaml')
    const runtimeData = getAtPath(runtimeConfig, ['data'])
    expect(Object.keys(runtimeData).some((key) => key.startsWith('HYPERLIQUID_RUNTIME_'))).toBe(false)
    expect(runtimeData.HYPERLIQUID_EXECUTION_TRADING_ENABLED).toBe('true')
    expect(runtimeData.HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES).toBe('true')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK).toBe('mainnet')
    expect(runtimeData.HYPERLIQUID_EXECUTION_EXECUTION_NETWORK).toBe('testnet')
    expect(runtimeData.HYPERLIQUID_EXECUTION_TRADE_COINS).toBe(
      'BTC,ETH,HYPE,SOL,xyz:SKHX,xyz:MU,xyz:XYZ100,xyz:CL,xyz:SNDK,xyz:MSTR,xyz:SILVER,xyz:GOLD',
    )
    expect(runtimeData.HYPERLIQUID_EXECUTION_EXCLUDED_COINS).toBe('SPX')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_ORDER_NOTIONAL_USD).toBe('10')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD).toBe('10')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_SYMBOL_EXPOSURE_USD).toBe('50')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_GROSS_EXPOSURE_USD).toBe('250')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED).toBe('true')
    expect(runtimeData.HYPERLIQUID_EXECUTION_ORDER_POLICY).toBe('marketable_ioc')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAKER_TIF).toBe('Ioc')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAKER_TTL_SECONDS).toBe('10')
    expect(runtimeData.HYPERLIQUID_EXECUTION_MAX_OPEN_ORDERS_PER_SYMBOL).toBe('1')
    expect(runtimeData.HYPERLIQUID_EXECUTION_FEED_READINESS_URL).toBe(
      'http://torghut-hyperliquid-feed.torghut.svc.cluster.local/readyz',
    )
    expect(runtimeData.HYPERLIQUID_EXECUTION_FEED_READINESS_TIMEOUT_SECONDS).toBe('3')

    const runtimeDeployment = parseManifest('argocd/applications/torghut-hyperliquid-runtime/deployment.yaml')
    expect(getAtPath(runtimeDeployment, ['spec']).replicas).toBe(1)
    expect(getAtPath(runtimeDeployment, ['spec']).revisionHistoryLimit).toBe(2)
    expect(getAtPath(runtimeDeployment, ['spec', 'template', 'metadata', 'annotations'])).toMatchObject({
      'proompteng.ai/config-revision': 'hyperliquid-execution-v2-feed-readiness-gate-20260704a',
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
    expect(readme).toContain('HYPERLIQUID_EXECUTION_TRADING_ENABLED=true')
    expect(readme).toContain('ORDER_POLICY=marketable_ioc')
    expect(readme).toContain('MAKER_TIF=Ioc')
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
})
