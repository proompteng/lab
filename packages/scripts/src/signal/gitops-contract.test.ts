import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse, parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dir, '../../../..')
const clickhouseDirectory = resolve(root, 'argocd/applications/torghut/clickhouse')
const read = (path: string) => readFileSync(resolve(clickhouseDirectory, path), 'utf8')
const readWsConfig = () => readFileSync(resolve(root, 'argocd/applications/torghut/ws/configmap.yaml'), 'utf8')
const readWsDeployment = () => readFileSync(resolve(root, 'argocd/applications/torghut/ws/deployment.yaml'), 'utf8')

const csv = (value: string): string[] => value.split(',').map((item) => item.trim())
const environment = (container: { env: Array<{ name: string }> }) =>
  new Map(container.env.map((entry) => [entry.name, entry]))
const universeRef = (key: string) => ({ valueFrom: { configMapKeyRef: { name: 'bayn-universe-v1', key } } })

const writerContainer = (writer: ReturnType<typeof parse>) =>
  writer.kind === 'CronJob'
    ? writer.spec.jobTemplate.spec.template.spec.containers[0]
    : writer.spec.template.spec.containers[0]

const assertActivationProvenance = (writer: ReturnType<typeof parse>, kustomization: ReturnType<typeof parse>) => {
  if (writer.spec.suspend) return
  const container = writerContainer(writer)
  const environment = new Map(container.env.map((entry: { name: string; value?: string }) => [entry.name, entry]))
  const image = kustomization.images.find(
    (entry: { name: string }) => entry.name === 'registry.ide-newton.ts.net/lab/signal-publisher',
  )
  expect(image.newTag).toMatch(/^sha-[0-9a-f]{40}$/)
  expect(image.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(environment.get('SIGNAL_CODE_REVISION')).toMatchObject({ value: image.newTag.slice(4) })
  expect(environment.get('SIGNAL_IMAGE_REPOSITORY')).toMatchObject({ value: image.newName })
  expect(environment.get('SIGNAL_IMAGE_DIGEST')).toMatchObject({ value: image.digest })
}

describe('Signal publisher GitOps authority contract', () => {
  test('requires immutable image provenance whenever the publisher is active', () => {
    const cronJob = parse(read('signal-publisher-cronjob.yaml'))
    const backfillJob = parse(read('signal-publisher-bayn-v1-backfill-job.yaml'))
    const kustomization = parse(read('kustomization.yaml'))
    const container = cronJob.spec.jobTemplate.spec.template.spec.containers[0]
    const variables = environment(container)

    expect(cronJob.spec).toMatchObject({
      schedule: '30 18 * * 1-5',
      timeZone: 'America/New_York',
      concurrencyPolicy: 'Forbid',
    })
    expect(typeof cronJob.spec.suspend).toBe('boolean')
    expect(typeof backfillJob.spec.suspend).toBe('boolean')
    expect(container.args).toEqual(['daily'])
    const cronManaged = kustomization.resources.includes('signal-publisher-cronjob.yaml')
    const backfillManaged = kustomization.resources.includes('signal-publisher-bayn-v1-backfill-job.yaml')
    expect(cronManaged).toBe(!cronJob.spec.suspend)
    expect(backfillManaged).toBe(!backfillJob.spec.suspend)
    expect(cronManaged && backfillManaged).toBe(false)
    expect(cronJob.spec.suspend || backfillJob.spec.suspend).toBe(true)
    assertActivationProvenance(cronJob, kustomization)
    assertActivationProvenance(backfillJob, kustomization)
    expect(variables.get('SIGNAL_CLICKHOUSE_USERNAME')).toMatchObject({
      valueFrom: { secretKeyRef: { name: 'signal-publisher-clickhouse-auth', key: 'username' } },
    })
    expect(variables.get('SIGNAL_CLICKHOUSE_PASSWORD')).toMatchObject({
      valueFrom: { secretKeyRef: { name: 'signal-publisher-clickhouse-auth', key: 'password' } },
    })
    expect(variables.get('SIGNAL_UNIVERSE_ID')).toMatchObject(universeRef('UNIVERSE_ID'))
    expect(variables.get('SIGNAL_UNIVERSE_SYMBOL_HASH')).toMatchObject(universeRef('UNIVERSE_SYMBOL_HASH'))
    expect(variables.get('SIGNAL_SYMBOLS')).toMatchObject(universeRef('UNIVERSE_SYMBOLS'))
    expect(variables.get('SIGNAL_START_DATE')).toMatchObject(universeRef('HISTORY_START_DATE'))
    expect(variables.get('SIGNAL_ALPACA_FEED')).toMatchObject(universeRef('HISTORY_FEED'))
    expect([...variables.keys()].filter((name) => /BROKER|TIGERBEETLE|CAPITAL/.test(name))).toEqual([])
  })

  test('binds one exact versioned universe to websocket and both publisher modes', () => {
    const universe = parse(read('bayn-universe-v1-configmap.yaml'))
    const websocketConfig = parse(readWsConfig())
    const websocketDeployment = parse(readWsDeployment())
    const cronJob = parse(read('signal-publisher-cronjob.yaml'))
    const backfill = parse(read('signal-publisher-bayn-v1-backfill-job.yaml'))
    const selected = csv(universe.data.UNIVERSE_SYMBOLS)
    const expectedHash = createHash('sha256').update(selected.join(',')).digest('hex')
    const websocketVariables = environment(websocketDeployment.spec.template.spec.containers[0])
    const cronVariables = environment(cronJob.spec.jobTemplate.spec.template.spec.containers[0])
    const backfillVariables = environment(backfill.spec.template.spec.containers[0])

    expect(universe.metadata.annotations['bayn.proompteng.ai/contract']).toBe('equity-infrastructure-v1')
    expect(selected).toEqual(['AMD', 'AVGO', 'COHR', 'CRDO', 'LITE', 'MRVL', 'MU', 'NVDA', 'WDC'])
    expect(universe.data).toMatchObject({
      UNIVERSE_ID: 'equity-infrastructure-v1',
      UNIVERSE_SYMBOL_HASH: expectedHash,
      HISTORY_START_DATE: '2022-01-27',
      HISTORY_FEED: 'sip',
    })
    expect(websocketConfig.data.SYMBOLS).toBeUndefined()
    expect(websocketConfig.data.SYMBOLS_ALLOWLIST).toBeUndefined()
    expect(websocketVariables.get('SYMBOLS')).toMatchObject(universeRef('UNIVERSE_SYMBOLS'))
    expect(websocketVariables.get('SYMBOLS_ALLOWLIST')).toMatchObject(universeRef('UNIVERSE_SYMBOLS'))
    expect(websocketVariables.get('MARKET_DATA_UNIVERSE_ID')).toMatchObject(universeRef('UNIVERSE_ID'))
    expect(websocketVariables.get('MARKET_DATA_UNIVERSE_SYMBOL_HASH')).toMatchObject(
      universeRef('UNIVERSE_SYMBOL_HASH'),
    )
    for (const variables of [cronVariables, backfillVariables]) {
      expect(variables.get('SIGNAL_UNIVERSE_ID')).toMatchObject(universeRef('UNIVERSE_ID'))
      expect(variables.get('SIGNAL_UNIVERSE_SYMBOL_HASH')).toMatchObject(universeRef('UNIVERSE_SYMBOL_HASH'))
      expect(variables.get('SIGNAL_SYMBOLS')).toMatchObject(universeRef('UNIVERSE_SYMBOLS'))
      expect(variables.get('SIGNAL_START_DATE')).toMatchObject(universeRef('HISTORY_START_DATE'))
      expect(variables.get('SIGNAL_ALPACA_FEED')).toMatchObject(universeRef('HISTORY_FEED'))
      expect(variables.get('SIGNAL_OPERATION_TIMEOUT_MS')).toMatchObject({ value: '180000' })
    }
    expect(backfill.spec).toMatchObject({
      suspend: true,
      template: { spec: { containers: [{ args: ['backfill', '--start', '2022-01-27', '--end', '2026-07-20'] }] } },
    })
    expect(cronJob.spec.suspend).toBe(false)
    expect(backfill.spec.template.spec.containers[0]).toMatchObject({
      args: ['backfill', '--start', '2022-01-27', '--end', '2026-07-20'],
    })
  })

  test('always permits a fail-closed suspension', () => {
    const cronJob = structuredClone(parse(read('signal-publisher-cronjob.yaml')))
    const backfillJob = structuredClone(parse(read('signal-publisher-bayn-v1-backfill-job.yaml')))
    const kustomization = structuredClone(parse(read('kustomization.yaml')))
    cronJob.spec.suspend = true
    backfillJob.spec.suspend = true
    kustomization.images[0].newTag = 'bootstrap'
    delete kustomization.images[0].digest
    expect(() => assertActivationProvenance(cronJob, kustomization)).not.toThrow()
    expect(() => assertActivationProvenance(backfillJob, kustomization)).not.toThrow()
  })

  test('limits database authority to the versioned append-only publication tables', () => {
    const installation = parse(read('clickhouse-cluster.yaml'))
    const profiles = installation.spec.configuration.profiles
    const users = installation.spec.configuration.users
    expect(profiles).toMatchObject({
      'signal_publisher/insert_quorum': 2,
      'signal_publisher/insert_quorum_parallel': 0,
      'signal_publisher/insert_quorum_timeout': 60000,
      'signal_publisher/select_sequential_consistency': 1,
    })
    expect(users['signal_publisher/grants/query']).toEqual([
      'GRANT SELECT, INSERT ON signal.adjusted_daily_bars_v2',
      'GRANT SELECT, INSERT ON signal.exchange_sessions_v1',
      'GRANT INSERT ON signal.intraday_bars_1m_v1',
      'GRANT SELECT, INSERT ON signal.snapshot_manifests_v1',
      'GRANT SELECT, INSERT ON signal.snapshot_manifests_v2',
    ])
    expect(users['bayn/grants/query']).toEqual([
      'GRANT SELECT ON signal.adjusted_daily_bars_v1',
      'GRANT SELECT ON signal.adjusted_daily_bars_v2',
      'GRANT SELECT ON signal.exchange_sessions_v1',
      'GRANT SELECT ON signal.intraday_bars_1m_v1',
      'GRANT SELECT ON signal.snapshot_manifests_v1',
      'GRANT SELECT ON signal.snapshot_manifests_v2',
    ])
    expect(users['signal_publisher/grants/query'].join('\n')).not.toMatch(/\b(?:ALTER|CREATE|DROP|SYSTEM)\b|\.\*/)
  })

  test('orders schema creation before the publisher and wires every owned resource', () => {
    const schema = parse(read('signal-schema-job.yaml'))
    const migration = schema.spec.template.spec.containers[0].args[0] as string
    const kustomization = parse(read('kustomization.yaml'))
    const shellSyntax = spawnSync('bash', ['-n'], { input: migration, encoding: 'utf8' })

    expect(shellSyntax.stderr).toBe('')
    expect(shellSyntax.status).toBe(0)
    expect(schema.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('3')
    expect(parse(read('signal-publisher-cronjob.yaml')).metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('4')
    expect(migration.match(/ENGINE = ReplicatedMergeTree/g)).toHaveLength(4)
    expect(kustomization.resources).toEqual(
      expect.arrayContaining([
        'signal-publisher-sealed-secret.yaml',
        'signal-schema-job.yaml',
        'bayn-universe-v1-configmap.yaml',
      ]),
    )
    expect(kustomization.resources).toContain('signal-publisher-cronjob.yaml')
    expect(kustomization.resources).not.toContain('signal-publisher-bayn-v1-backfill-job.yaml')
  })

  test('creates a replicated bounded intraday archive schema for Bayn reads', () => {
    const schema = parse(read('intraday-bars-schema-job.yaml'))
    const migration = schema.spec.template.spec.containers[0].args[0] as string
    const kustomization = parse(read('kustomization.yaml'))
    const shellSyntax = spawnSync('bash', ['-n'], { input: migration, encoding: 'utf8' })

    expect(shellSyntax).toMatchObject({ status: 0, stderr: '' })
    expect(schema.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('3')
    expect(migration).toContain('signal.intraday_bars_1m_v1 ON CLUSTER default')
    expect(migration).toContain('ENGINE = ReplicatedReplacingMergeTree(')
    expect(migration).toContain('PARTITION BY toYYYYMM(event_ts)')
    expect(migration).toContain('ORDER BY (universe_id, feed, symbol, event_ts)')
    expect(migration).toContain('TTL toDateTime(event_ts) + INTERVAL 400 DAY DELETE')
    expect(migration).toContain('for host in "${hosts[@]}"; do')
    expect(migration).toContain('FROM system.tables')
    expect(migration).toContain('FROM system.columns')
    expect(kustomization.resources).toContain('intraday-bars-schema-job.yaml')
  })

  test('activates the archive for delayed SIP while overnight observation remains disabled', () => {
    const torghutKustomization = parse(
      readFileSync(resolve(root, 'argocd/applications/torghut/kustomization.yaml'), 'utf8'),
    )
    const archiveDirectory = resolve(root, 'argocd/applications/torghut/market-data-archive')
    const archiveKustomization = parse(readFileSync(resolve(archiveDirectory, 'kustomization.yaml'), 'utf8'))
    const archive = parse(readFileSync(resolve(archiveDirectory, 'flinkdeployment.yaml'), 'utf8'))
    const config = parse(readFileSync(resolve(archiveDirectory, 'configmap.yaml'), 'utf8'))
    const websocket = parse(readWsConfig())
    const websocketDeployment = parse(
      readFileSync(resolve(root, 'argocd/applications/torghut/ws/deployment.yaml'), 'utf8'),
    )

    expect(torghutKustomization.resources).toContain('market-data-archive')
    expect(archiveKustomization.resources).toEqual([
      'configmap.yaml',
      'flinkdeployment.yaml',
      'metrics-service.yaml',
      'pdb.yaml',
    ])
    expect(archive.spec).toMatchObject({
      restartNonce: 4,
      job: {
        entryClass: 'ai.proompteng.dorvud.ta.flink.MarketDataArchiveJobKt',
        parallelism: 3,
        state: 'running',
      },
      taskManager: { replicas: 2 },
    })
    expect(config.data).toMatchObject({
      ARCHIVE_IEX_BARS_TOPIC: 'torghut.bars.1m.v1',
      ARCHIVE_DELAYED_SIP_BARS_TOPIC: 'bayn.market-data.delayed-sip.bars.1m.v1',
      ARCHIVE_OVERNIGHT_BARS_TOPIC: 'bayn.market-data.overnight.bars.1m.v1',
      ARCHIVE_PARALLELISM: '3',
      ARCHIVE_CLICKHOUSE_URL:
        'jdbc:clickhouse://torghut-clickhouse.torghut.svc.cluster.local:8123/signal?clickhouse_setting_insert_quorum_parallel=1',
      ARCHIVE_CLICKHOUSE_USERNAME: 'signal_publisher',
    })
    const archiveEnvironment = environment(archive.spec.podTemplate.spec.containers[0])
    expect(archive.spec.podTemplate.spec.containers[0].envFrom).toEqual(
      expect.arrayContaining([
        { configMapRef: { name: 'market-data-archive-config' } },
        { configMapRef: { name: 'bayn-universe-v1' } },
      ]),
    )
    expect(archiveEnvironment.get('ARCHIVE_CLICKHOUSE_PASSWORD')).toMatchObject({
      valueFrom: { secretKeyRef: { name: 'signal-publisher-clickhouse-auth', key: 'password' } },
    })
    expect(websocket.data.ALPACA_OBSERVATION_FEEDS).toBe('delayed_sip')
    expect(archive.metadata.annotations).toMatchObject({
      'argocd.argoproj.io/sync-wave': '4',
    })
    expect(websocketDeployment.metadata.annotations).toMatchObject({
      'argocd.argoproj.io/sync-wave': '5',
    })
    expect(websocketDeployment.spec.template.metadata.annotations).toMatchObject({
      'torghut.proompteng.ai/ws-config-generation': 'bayn-delayed-sip-v1',
    })
  })

  test('provisions isolated bounded Kafka topics for observation feeds', () => {
    const topicsPath = resolve(root, 'argocd/applications/kafka/bayn-market-data-topics.yaml')
    const topics = parseAllDocuments(readFileSync(topicsPath, 'utf8')).map((document) => document.toJS())
    const kafkaKustomization = parse(
      readFileSync(resolve(root, 'argocd/applications/kafka/kustomization.yaml'), 'utf8'),
    )
    const names = topics.map((topic) => topic.metadata.name)

    expect(new Set(names).size).toBe(7)
    expect(names).toEqual(
      expect.arrayContaining([
        'bayn.market-data.delayed-sip.trades.v1',
        'bayn.market-data.delayed-sip.quotes.v1',
        'bayn.market-data.delayed-sip.bars.1m.v1',
        'bayn.market-data.overnight.trades.v1',
        'bayn.market-data.overnight.quotes.v1',
        'bayn.market-data.overnight.bars.1m.v1',
        'bayn.market-data.observation.status.v1',
      ]),
    )
    for (const topic of topics) {
      expect(topic.spec).toMatchObject({ partitions: 3, replicas: 3 })
      expect(topic.spec.config['compression.type']).toBe('lz4')
      if (topic.metadata.name.includes('.bars.1m.')) {
        expect(topic.spec.config['retention.ms']).toBe(3_024_000_000)
      } else {
        expect(topic.spec.config['retention.ms']).toBe(604_800_000)
      }
    }
    expect(kafkaKustomization.resources).toContain('bayn-market-data-topics.yaml')
  })
})
