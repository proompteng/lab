import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

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
    }
    expect(backfill.spec).toMatchObject({
      suspend: false,
      template: { spec: { containers: [{ args: ['backfill', '--start', '2022-01-27', '--end', '2026-07-20'] }] } },
    })
    expect(cronJob.spec.suspend).toBe(true)
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
      'GRANT SELECT, INSERT ON signal.snapshot_manifests_v1',
      'GRANT SELECT, INSERT ON signal.snapshot_manifests_v2',
    ])
    expect(users['bayn/grants/query']).toEqual([
      'GRANT SELECT ON signal.adjusted_daily_bars_v1',
      'GRANT SELECT ON signal.adjusted_daily_bars_v2',
      'GRANT SELECT ON signal.exchange_sessions_v1',
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
    expect(kustomization.resources).not.toContain('signal-publisher-cronjob.yaml')
    expect(kustomization.resources).toContain('signal-publisher-bayn-v1-backfill-job.yaml')
  })
})
