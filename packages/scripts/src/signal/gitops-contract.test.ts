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
const readSchedulerDeployment = () =>
  readFileSync(resolve(root, 'argocd/applications/torghut/scheduler-deployment.yaml'), 'utf8')

const csv = (value: string): string[] => value.split(',').map((item) => item.trim())
const environment = (container: { env: Array<{ name: string }> }) =>
  new Map(container.env.map((entry) => [entry.name, entry]))
const universeRef = (key: string) => ({ valueFrom: { configMapKeyRef: { name: 'bayn-universe-v2', key } } })

const assertActivationProvenance = (cronJob: ReturnType<typeof parse>, kustomization: ReturnType<typeof parse>) => {
  if (cronJob.spec.suspend) return
  const container = cronJob.spec.jobTemplate.spec.template.spec.containers[0]
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
    const kustomization = parse(read('kustomization.yaml'))
    const container = cronJob.spec.jobTemplate.spec.template.spec.containers[0]
    const variables = environment(container)

    expect(cronJob.spec).toMatchObject({
      schedule: '30 18 * * 1-5',
      timeZone: 'America/New_York',
      concurrencyPolicy: 'Forbid',
    })
    expect(typeof cronJob.spec.suspend).toBe('boolean')
    expect(container.args).toEqual(['daily'])
    const cronManaged = kustomization.resources.includes('signal-publisher-cronjob.yaml')
    expect(cronManaged).toBe(!cronJob.spec.suspend)
    assertActivationProvenance(cronJob, kustomization)
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

  test('binds one exact versioned universe to websocket and the scheduled publisher', () => {
    const universe = parse(read('bayn-universe-v2-configmap.yaml'))
    const websocketConfig = parse(readWsConfig())
    const websocketDeployment = parse(readWsDeployment())
    const schedulerDeployment = parse(readSchedulerDeployment())
    const cronJob = parse(read('signal-publisher-cronjob.yaml'))
    const selected = csv(universe.data.UNIVERSE_SYMBOLS)
    const expectedHash = createHash('sha256').update(selected.join(',')).digest('hex')
    const websocketVariables = environment(websocketDeployment.spec.template.spec.containers[0])
    const schedulerVariables = environment(schedulerDeployment.spec.template.spec.containers[0])
    const cronVariables = environment(cronJob.spec.jobTemplate.spec.template.spec.containers[0])
    const coreSymbols = csv(websocketConfig.data.SYMBOLS)
    const schedulerSymbols = csv(schedulerVariables.get('TRADING_UNIVERSE_SYMBOL_ALLOWLIST')?.value ?? '')
    const decisionSymbols = ['AAPL', 'AMZN', 'NVDA', 'SPY']
    const channels = csv(websocketConfig.data.ALPACA_MARKET_DATA_CHANNELS)
    const symbolsByChannel = {
      bars: csv(websocketConfig.data.ALPACA_MARKET_DATA_BARS_SYMBOLS),
      quotes: csv(websocketConfig.data.ALPACA_MARKET_DATA_QUOTES_SYMBOLS),
      trades: csv(websocketConfig.data.ALPACA_MARKET_DATA_TRADES_SYMBOLS),
    }

    expect(universe.metadata.annotations['bayn.proompteng.ai/contract']).toBe('cross-asset-taa-v1')
    expect(selected).toEqual(['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'])
    expect(universe.data).toMatchObject({
      UNIVERSE_ID: 'cross-asset-taa-v1',
      UNIVERSE_SYMBOL_HASH: expectedHash,
      HISTORY_START_DATE: '2016-01-04',
      HISTORY_FEED: 'sip',
    })
    expect(schedulerSymbols.every((symbol) => coreSymbols.includes(symbol))).toBe(true)
    expect(csv(websocketConfig.data.SYMBOLS_ALLOWLIST)).toEqual(coreSymbols)
    expect(symbolsByChannel.bars).toEqual(coreSymbols)
    expect(symbolsByChannel.bars).toHaveLength(22)
    expect(websocketConfig.data.ALPACA_LATEST_BAR_SYMBOLS).toBeUndefined()
    expect(channels).toEqual(['trades', 'quotes', 'bars'])
    expect(symbolsByChannel.quotes).toEqual(decisionSymbols)
    expect(symbolsByChannel.trades).toEqual(decisionSymbols)
    expect(csv(websocketConfig.data.ALPACA_LATEST_SYMBOLS)).toEqual(
      coreSymbols.filter((symbol) => !decisionSymbols.includes(symbol)),
    )
    expect(channels.reduce((total, channel) => total + symbolsByChannel[channel].length, 0)).toBe(30)
    expect(
      websocketDeployment.spec.template.metadata.annotations['torghut.proompteng.ai/market-data-subscription-plan'],
    ).toBe('iex-all-bars-v1')
    expect(selected.length * 4).toBeLessThanOrEqual(30)
    expect(websocketVariables.get('ALPACA_OBSERVATION_SYMBOLS')).toMatchObject(universeRef('UNIVERSE_SYMBOLS'))
    expect(websocketVariables.get('MARKET_DATA_UNIVERSE_ID')).toMatchObject(universeRef('UNIVERSE_ID'))
    expect(websocketVariables.get('MARKET_DATA_UNIVERSE_SYMBOL_HASH')).toMatchObject(
      universeRef('UNIVERSE_SYMBOL_HASH'),
    )
    expect(cronVariables.get('SIGNAL_UNIVERSE_ID')).toMatchObject(universeRef('UNIVERSE_ID'))
    expect(cronVariables.get('SIGNAL_UNIVERSE_SYMBOL_HASH')).toMatchObject(universeRef('UNIVERSE_SYMBOL_HASH'))
    expect(cronVariables.get('SIGNAL_SYMBOLS')).toMatchObject(universeRef('UNIVERSE_SYMBOLS'))
    expect(cronVariables.get('SIGNAL_START_DATE')).toMatchObject(universeRef('HISTORY_START_DATE'))
    expect(cronVariables.get('SIGNAL_ALPACA_FEED')).toMatchObject(universeRef('HISTORY_FEED'))
    expect(cronVariables.get('SIGNAL_OPERATION_TIMEOUT_MS')).toMatchObject({ value: '180000' })
    expect(cronJob.spec.suspend).toBe(false)
  })

  test('always permits a fail-closed suspension', () => {
    const cronJob = structuredClone(parse(read('signal-publisher-cronjob.yaml')))
    const kustomization = structuredClone(parse(read('kustomization.yaml')))
    cronJob.spec.suspend = true
    kustomization.images[0].newTag = 'bootstrap'
    delete kustomization.images[0].digest
    expect(() => assertActivationProvenance(cronJob, kustomization)).not.toThrow()
  })

  test('runs the immutable daily publisher with no one-shot backfill', () => {
    const cronJob = parse(read('signal-publisher-cronjob.yaml'))
    const kustomization = parse(read('kustomization.yaml'))
    const managedBackfills = kustomization.resources.filter((path: string) => path.includes('backfill'))

    expect(cronJob.spec).toMatchObject({
      suspend: false,
      schedule: '30 18 * * 1-5',
      timeZone: 'America/New_York',
      concurrencyPolicy: 'Forbid',
    })
    expect(kustomization.resources).toContain('signal-publisher-cronjob.yaml')
    expect(managedBackfills).toEqual([])
  })

  test('limits database authority to the versioned append-only publication tables', () => {
    const installation = parse(read('clickhouse-cluster.yaml'))
    const profiles = installation.spec.configuration.profiles
    const users = installation.spec.configuration.users
    expect(profiles).toMatchObject({
      'bayn/select_sequential_consistency': 1,
      'signal_publisher/insert_quorum': 2,
      'signal_publisher/insert_quorum_parallel': 0,
      'signal_publisher/insert_quorum_timeout': 60000,
      'signal_publisher/select_sequential_consistency': 1,
    })
    expect(users['signal_publisher/grants/query']).toEqual([
      'GRANT INSERT ON signal.webull_market_events_v1',
      'GRANT SELECT, INSERT ON signal.adjusted_daily_bars_v2',
      'GRANT SELECT, INSERT ON signal.exchange_sessions_v1',
      'GRANT INSERT ON signal.intraday_bars_1m_v1',
      'GRANT INSERT ON signal.intraday_bars_1m_v2',
      'GRANT INSERT ON signal.intraday_quotes_v1',
      'GRANT INSERT ON signal.intraday_trades_v1',
      'GRANT INSERT ON signal.intraday_features_v1',
      'GRANT INSERT ON signal.crypto_market_events_v1',
      'GRANT INSERT ON signal.crypto_market_features_v1',
      'GRANT SELECT, INSERT ON signal.snapshot_manifests_v1',
      'GRANT SELECT, INSERT ON signal.snapshot_manifests_v2',
    ])
    expect(users['bayn/grants/query']).toEqual([
      'GRANT SELECT ON signal.adjusted_daily_bars_v1',
      'GRANT SELECT ON signal.adjusted_daily_bars_v2',
      'GRANT SELECT ON signal.exchange_sessions_v1',
      'GRANT SELECT ON signal.intraday_bars_1m_v1',
      'GRANT SELECT ON signal.intraday_bars_1m_v2',
      'GRANT SELECT ON signal.intraday_quotes_v1',
      'GRANT SELECT ON signal.intraday_trades_v1',
      'GRANT SELECT ON signal.intraday_features_v1',
      'GRANT SELECT ON signal.crypto_market_events_v1',
      'GRANT SELECT ON signal.webull_research_events_v1',
      'GRANT SELECT ON signal.snapshot_manifests_v1',
      'GRANT SELECT ON signal.snapshot_manifests_v2',
    ])
    expect(users['signal_publisher/grants/query'].join('\n')).not.toMatch(/\b(?:ALTER|CREATE|DROP|SYSTEM)\b|\.\*/)
  })

  test('orders schema creation before the publisher and wires every owned resource', () => {
    const schema = parse(read('signal-schema-job.yaml'))
    const cronJob = parse(read('signal-publisher-cronjob.yaml'))
    const migration = read('schema/adjusted-daily.sql')
    const kustomization = parse(read('kustomization.yaml'))
    const shellSyntax = spawnSync('bash', ['-n'], { input: read('schema/reconcile.sh'), encoding: 'utf8' })

    expect(shellSyntax.stderr).toBe('')
    expect(shellSyntax.status).toBe(0)
    expect(schema.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('3')
    expect(cronJob.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('4')
    expect(migration.match(/ENGINE = ReplicatedMergeTree/g)).toHaveLength(4)
    expect(kustomization.resources).toEqual(
      expect.arrayContaining([
        'signal-publisher-sealed-secret.yaml',
        'signal-schema-job.yaml',
        'bayn-universe-v2-configmap.yaml',
      ]),
    )
    expect(kustomization.resources.includes('signal-publisher-cronjob.yaml')).toBe(!cronJob.spec.suspend)
    expect(kustomization.resources.filter((path: string) => path.includes('backfill'))).toEqual([])
  })

  test('creates a replicated bounded intraday archive schema for Bayn reads', () => {
    const schema = parse(read('signal-schema-job.yaml'))
    const migration = read('schema/intraday-bars.sql') + read('schema/intraday-bars.verify.sql')
    const backfill = read('backfill-intraday-bars-v2.sql')
    const kustomization = parse(read('kustomization.yaml'))
    const shellSyntax = spawnSync('bash', ['-n'], { input: read('schema/reconcile.sh'), encoding: 'utf8' })

    expect(shellSyntax).toMatchObject({ status: 0, stderr: '' })
    expect(schema.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('3')
    expect(migration).toContain('signal.intraday_bars_1m_v1')
    expect(migration).toContain('signal.intraday_bars_1m_v2')
    expect(migration).toContain('signal.intraday_quotes_v1')
    expect(migration).toContain('signal.intraday_trades_v1')
    expect(migration).toContain('signal.crypto_market_events_v1')
    expect(migration).toContain('signal.crypto_market_features_v1')
    expect(migration).toContain('TTL toDateTime(window_end) + INTERVAL 30 DAY DELETE')
    expect(migration).toContain('TTL toDateTime(event_ts) + INTERVAL 30 DAY DELETE')
    expect(migration.match(/event_ts DateTime64\(9, 'UTC'\)/g)).toHaveLength(3)
    expect(migration.match(/ingest_ts DateTime64\(9, 'UTC'\)/g)).toHaveLength(3)
    expect(migration).toContain('ENGINE = ReplicatedReplacingMergeTree(')
    expect(migration).toContain('PARTITION BY toYYYYMM(event_ts)')
    expect(migration).toContain('universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset')
    expect(migration).toContain('TTL toDateTime(event_ts) + INTERVAL 400 DAY DELETE')
    expect(migration.match(/TTL toDateTime\(event_ts\) \+ INTERVAL 120 DAY DELETE/g)).toHaveLength(2)
    expect(read('schema/reconcile.sh')).toContain('for host in "${hosts[@]}"; do')
    expect(migration).toContain('FROM system.tables')
    expect(migration).toContain('FROM system.columns')
    expect(backfill).toContain('FROM signal.intraday_bars_1m_v1 AS src FINAL')
    expect(backfill).toContain('LEFT ANTI JOIN signal.intraday_bars_1m_v2 AS dst')
    expect(backfill).toContain('Signal immutable intraday-bars backfill is incomplete')
    expect(kustomization.resources).toContain('signal-schema-job.yaml')
    expect(kustomization.configMapGenerator[0].files).toContain('schema/intraday-bars.sql')
  })

  test('runs the IEX archive from a fresh current-session consumer generation', () => {
    const torghutKustomization = parse(
      readFileSync(resolve(root, 'argocd/applications/torghut/kustomization.yaml'), 'utf8'),
    )
    const archiveDirectory = resolve(root, 'argocd/applications/torghut/market-data-archive')
    const archiveKustomization = parse(readFileSync(resolve(archiveDirectory, 'kustomization.yaml'), 'utf8'))
    const archive = parse(readFileSync(resolve(archiveDirectory, 'flinkdeployment.yaml'), 'utf8'))
    const config = parse(readFileSync(resolve(archiveDirectory, 'configmap.yaml'), 'utf8'))
    const coreTopics = parseAllDocuments(
      readFileSync(resolve(root, 'argocd/applications/kafka/torghut-topics.yaml'), 'utf8'),
    ).map((document) => document.toJS())
    const websocket = parse(readWsConfig())
    const websocketDeployment = parse(
      readFileSync(resolve(root, 'argocd/applications/torghut/ws/deployment.yaml'), 'utf8'),
    )

    expect(torghutKustomization.resources).toContain('market-data-archive')
    expect(archiveKustomization.resources).toEqual([
      'configmap.yaml',
      'flinkdeployment.yaml',
      'metrics-service.yaml',
      'taskmanager-metrics-service.yaml',
      'pdb.yaml',
      'sip-shadow-configmap.yaml',
    ])
    expect(archive.spec).toMatchObject({
      restartNonce: 14,
      job: {
        entryClass: 'ai.proompteng.dorvud.ta.flink.MarketDataArchiveJobKt',
        parallelism: 16,
        state: 'running',
        upgradeMode: 'savepoint',
      },
      taskManager: {
        replicas: 8,
        resource: {
          cpu: 2,
          memory: '2048m',
        },
      },
    })
    expect(Number.isSafeInteger(archive.spec.restartNonce)).toBe(true)
    expect(archive.spec.restartNonce).toBeGreaterThan(0)
    const coreArchiveSymbols = csv(config.data.ARCHIVE_CORE_UNIVERSE_SYMBOLS)
    const expectedCoreArchiveHash = createHash('sha256').update(coreArchiveSymbols.join(',')).digest('hex')
    expect(config.data).toMatchObject({
      ARCHIVE_GROUP_ID: 'bayn-market-data-archive-v3',
      ARCHIVE_CRYPTO_TOPIC: 'bayn.market-data.crypto.v1',
      ARCHIVE_CRYPTO_LOCATION: 'us',
      ARCHIVE_CRYPTO_SYMBOLS: 'BTC/USD,ETH/USD,SOL/USD',
      ARCHIVE_OFFSET_RESET: 'latest',
      ARCHIVE_CORE_FEED: 'iex',
      ARCHIVE_CORE_BARS_TOPIC: 'torghut.bars.1m.v1',
      ARCHIVE_CORE_QUOTES_TOPIC: 'torghut.quotes.v1',
      ARCHIVE_CORE_TRADES_TOPIC: 'torghut.trades.v1',
      ARCHIVE_CORE_UNIVERSE_ID: 'torghut-core-equity-v3',
      ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH: expectedCoreArchiveHash,
      ARCHIVE_DELAYED_SIP_BARS_TOPIC: 'bayn.market-data.delayed-sip.bars.1m.v1',
      ARCHIVE_DELAYED_SIP_QUOTES_TOPIC: 'bayn.market-data.delayed-sip.quotes.v1',
      ARCHIVE_DELAYED_SIP_TRADES_TOPIC: 'bayn.market-data.delayed-sip.trades.v1',
      ARCHIVE_OVERNIGHT_BARS_TOPIC: 'bayn.market-data.overnight.bars.1m.v1',
      ARCHIVE_PARALLELISM: '16',
      ARCHIVE_CLICKHOUSE_URL:
        'jdbc:clickhouse://torghut-clickhouse.torghut.svc.cluster.local:8123/signal?clickhouse_setting_insert_quorum_parallel=1',
      ARCHIVE_CLICKHOUSE_USERNAME: 'signal_publisher',
    })
    const liveCoreSymbols = csv(websocket.data.SYMBOLS)
    const liveCoreChannels = csv(websocket.data.ALPACA_MARKET_DATA_CHANNELS)
    const liveDecisionSymbols = ['AAPL', 'AMZN', 'NVDA', 'SPY']
    expect(liveCoreSymbols).toEqual(coreArchiveSymbols)
    expect(csv(websocket.data.SYMBOLS_ALLOWLIST)).toEqual(liveCoreSymbols)
    expect(csv(websocket.data.ALPACA_MARKET_DATA_QUOTES_SYMBOLS)).toEqual(liveDecisionSymbols)
    expect(csv(websocket.data.ALPACA_MARKET_DATA_TRADES_SYMBOLS)).toEqual(liveDecisionSymbols)
    expect(liveCoreChannels).toEqual(['trades', 'quotes', 'bars'])
    const websocketBars = csv(websocket.data.ALPACA_MARKET_DATA_BARS_SYMBOLS)
    expect(websocketBars.length + liveDecisionSymbols.length * 2).toBe(30)
    expect(websocketBars).toEqual(coreArchiveSymbols)
    expect(websocket.data.ALPACA_LATEST_BAR_SYMBOLS).toBeUndefined()
    expect(coreTopics.find((topic) => topic.metadata.name === 'torghut.quotes.v1')?.spec.partitions).toBe(13)
    expect(websocket.data.ALPACA_FEED).toBe('iex')
    expect(websocketDeployment.metadata.namespace).toBe('bayn')
    expect(websocketDeployment.spec.replicas).toBe(1)
    expect(websocketDeployment.spec.strategy.type).toBe('Recreate')
    expect(websocket.data.ALPACA_MARKET_DATA_PROXY_URL).toBe('http://bayn-egress-proxy.bayn.svc.cluster.local:3130')
    expect(websocket.data.ENABLE_TRADE_UPDATES).toBe('false')
    expect(websocket.data.ALPACA_TRADE_STREAM_URL).toBeUndefined()
    expect(websocket.data.TORGHUT_ACCOUNT_LABEL).toBeUndefined()
    expect(websocket.data.TOPIC_CRYPTO_EVENTS).toBe(config.data.ARCHIVE_CRYPTO_TOPIC)
    expect(websocket.data.ALPACA_CRYPTO_LOCATION).toBe(config.data.ARCHIVE_CRYPTO_LOCATION)
    expect(websocket.data.ALPACA_CRYPTO_SYMBOLS).toBe(config.data.ARCHIVE_CRYPTO_SYMBOLS)
    const ta = parse(readFileSync(resolve(root, 'argocd/applications/torghut/ta/configmap.yaml'), 'utf8'))
    expect(ta.data.TA_CRYPTO_TOPIC).toBe(config.data.ARCHIVE_CRYPTO_TOPIC)
    expect(ta.data.TA_CRYPTO_LOCATION).toBe(config.data.ARCHIVE_CRYPTO_LOCATION)
    expect(ta.data.TA_CRYPTO_SYMBOLS).toBe(config.data.ARCHIVE_CRYPTO_SYMBOLS)
    expect(ta.data.TA_CRYPTO_FEATURES_TOPIC).toBe('bayn.market-data.crypto.features.v1')
    expect(ta.data.TA_CRYPTO_FEATURES_TOPIC).toBe(config.data.ARCHIVE_CRYPTO_FEATURES_TOPIC)
    expect(ta.data.TA_CRYPTO_FEATURES_TOPIC).not.toBe(ta.data.TA_CRYPTO_TOPIC)
    expect(environment(websocketDeployment.spec.template.spec.containers[0]).get('ALPACA_KEY_ID')).toEqual({
      name: 'ALPACA_KEY_ID',
      valueFrom: { secretKeyRef: { name: 'bayn-alpaca-auth', key: 'key-id' } },
    })
    expect(environment(websocketDeployment.spec.template.spec.containers[0]).get('ALPACA_SECRET_KEY')).toEqual({
      name: 'ALPACA_SECRET_KEY',
      valueFrom: { secretKeyRef: { name: 'bayn-alpaca-auth', key: 'secret-key' } },
    })
    const archiveEnvironment = environment(archive.spec.podTemplate.spec.containers[0])
    expect(archive.spec.podTemplate.spec.containers[0].envFrom).toEqual(
      expect.arrayContaining([
        { configMapRef: { name: 'market-data-archive-config' } },
        { configMapRef: { name: 'bayn-universe-v2' } },
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
  })

  test('parks the SIP forwarder and archive settings without attaching them to live routes', () => {
    const torghut = resolve(root, 'argocd/applications/torghut')
    const load = (path: string) => parse(readFileSync(resolve(torghut, path), 'utf8'))
    const sip = load('ws/sip-configmap.yaml')
    const deployment = load('ws/sip-deployment.yaml')
    const service = load('ws/sip-service.yaml')
    const producer = deployment.spec.template.spec.containers[0]
    const archive = load('market-data-archive/flinkdeployment.yaml')
    const archiveConfig = load('market-data-archive/configmap.yaml')
    const shadow = load('market-data-archive/sip-shadow-configmap.yaml')
    const symbols = csv(sip.data.SYMBOLS)
    const hash = '89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b'

    expect(symbols).toHaveLength(73)
    expect(symbols).toEqual([...new Set(symbols)].sort())
    expect(createHash('sha256').update(sip.data.SYMBOLS).digest('hex')).toBe(hash)
    expect(sip.data).toMatchObject({
      ALPACA_FEED: 'sip',
      ALPACA_MARKET_DATA_ENTITLEMENT: 'algo_trader_plus',
      ALPACA_MARKET_DATA_CHANNELS: 'bars,quotes,trades',
      SYMBOLS_ALLOWLIST: sip.data.SYMBOLS,
      MARKET_DATA_UNIVERSE_ID: 'torghut-core-equity-sip-v1',
      MARKET_DATA_UNIVERSE_SYMBOL_HASH: hash,
      ENABLE_TRADE_UPDATES: 'false',
      ENABLE_BARS_BACKFILL: 'false',
      ENABLE_TRADES_BACKFILL: 'false',
      TOPIC_BARS_1M: 'bayn.market-data.sip.bars.1m.v1',
      TOPIC_QUOTES: 'bayn.market-data.sip.quotes.v1',
      TOPIC_TRADES: 'bayn.market-data.sip.trades.v1',
      TOPIC_STATUS: 'bayn.market-data.sip.status.v1',
    })
    expect(sip.data.ALPACA_LATEST_SYMBOLS).toBeUndefined()
    expect(sip.data.ALPACA_OBSERVATION_FEEDS).toBeUndefined()
    expect(load('ws/kustomization.yaml').resources).toEqual(
      expect.arrayContaining(['sip-configmap.yaml', 'sip-deployment.yaml', 'sip-service.yaml']),
    )
    expect(deployment.spec.replicas).toBe(0)
    expect(deployment.spec.strategy.type).toBe('Recreate')
    expect(deployment.spec.selector.matchLabels).toEqual({ app: 'torghut-ws-sip' })
    expect(deployment.spec.template.metadata.labels).toMatchObject(deployment.spec.selector.matchLabels)
    expect(service.spec.selector).toEqual(deployment.spec.selector.matchLabels)
    const liveProducer = parse(readWsDeployment()).spec.template.spec.containers[0]
    expect(producer.image.split('@')[0]).toBe(liveProducer.image.split('@')[0])
    expect(producer.envFrom).toEqual([{ configMapRef: { name: sip.metadata.name } }])
    for (const key of ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'KAFKA_SASL_USER', 'KAFKA_SASL_PASSWORD']) {
      expect(environment(producer).get(key)).toEqual(environment(liveProducer).get(key))
    }

    expect(shadow.data).toEqual({
      ARCHIVE_SIP_SHADOW_UNIVERSE_ID: sip.data.MARKET_DATA_UNIVERSE_ID,
      ARCHIVE_SIP_SHADOW_UNIVERSE_SYMBOLS: sip.data.SYMBOLS,
      ARCHIVE_SIP_SHADOW_UNIVERSE_SYMBOL_HASH: hash,
      ARCHIVE_SIP_SHADOW_BARS_TOPIC: sip.data.TOPIC_BARS_1M,
      ARCHIVE_SIP_SHADOW_QUOTES_TOPIC: sip.data.TOPIC_QUOTES,
      ARCHIVE_SIP_SHADOW_TRADES_TOPIC: sip.data.TOPIC_TRADES,
    })
    const archiveContainer = archive.spec.podTemplate.spec.containers[0]
    expect(archiveContainer.envFrom).not.toContainEqual({ configMapRef: { name: shadow.metadata.name } })
    expect(
      [...environment(archiveContainer).keys(), ...Object.keys(archiveConfig.data)].some((key) =>
        key.startsWith('ARCHIVE_SIP_SHADOW_'),
      ),
    ).toBe(false)
  })

  test('provisions isolated bounded Kafka topics for observation feeds', () => {
    const topicsPath = resolve(root, 'argocd/applications/kafka/bayn-market-data-topics.yaml')
    const topics = parseAllDocuments(readFileSync(topicsPath, 'utf8')).map((document) => document.toJS())
    const kafkaKustomization = parse(
      readFileSync(resolve(root, 'argocd/applications/kafka/kustomization.yaml'), 'utf8'),
    )
    const names = topics.map((topic) => topic.metadata.name)

    expect(new Set(names).size).toBe(13)
    expect(names).toEqual(
      expect.arrayContaining([
        'bayn.market-data.delayed-sip.trades.v1',
        'bayn.market-data.delayed-sip.quotes.v1',
        'bayn.market-data.delayed-sip.bars.1m.v1',
        'bayn.market-data.overnight.trades.v1',
        'bayn.market-data.overnight.quotes.v1',
        'bayn.market-data.overnight.bars.1m.v1',
        'bayn.market-data.observation.status.v1',
        'bayn.market-data.crypto.v1',
        'bayn.market-data.crypto.features.v1',
        'bayn.market-data.sip.trades.v1',
        'bayn.market-data.sip.quotes.v1',
        'bayn.market-data.sip.bars.1m.v1',
        'bayn.market-data.sip.status.v1',
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
    for (const channel of ['bars.1m', 'quotes', 'trades', 'status']) {
      const predecessor = channel === 'status' ? 'observation' : 'delayed-sip'
      const existing = topics.find((topic) => topic.metadata.name === `bayn.market-data.${predecessor}.${channel}.v1`)
      const sip = topics.find((topic) => topic.metadata.name === `bayn.market-data.sip.${channel}.v1`)
      expect(sip.spec).toEqual(existing.spec)
    }
    expect(kafkaKustomization.resources).toContain('bayn-market-data-topics.yaml')
  })
})
