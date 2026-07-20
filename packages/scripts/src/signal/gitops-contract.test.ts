import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

const root = resolve(import.meta.dir, '../../../..')
const clickhouseDirectory = resolve(root, 'argocd/applications/torghut/clickhouse')
const read = (path: string) => readFileSync(resolve(clickhouseDirectory, path), 'utf8')

describe('Signal publisher GitOps authority contract', () => {
  test('keeps the publisher suspended until immutable image promotion', () => {
    const cronJob = parse(read('signal-publisher-cronjob.yaml'))
    const container = cronJob.spec.jobTemplate.spec.template.spec.containers[0]
    const environment = new Map(container.env.map((entry: { name: string; value?: string }) => [entry.name, entry]))

    expect(cronJob.spec).toMatchObject({
      schedule: '30 18 * * 1-5',
      timeZone: 'America/New_York',
      concurrencyPolicy: 'Forbid',
      suspend: true,
    })
    expect(container.args).toEqual(['daily'])
    expect(environment.get('SIGNAL_CLICKHOUSE_USERNAME')).toMatchObject({
      valueFrom: { secretKeyRef: { name: 'signal-publisher-clickhouse-auth', key: 'username' } },
    })
    expect(environment.get('SIGNAL_CLICKHOUSE_PASSWORD')).toMatchObject({
      valueFrom: { secretKeyRef: { name: 'signal-publisher-clickhouse-auth', key: 'password' } },
    })
    expect(environment.get('SIGNAL_ALPACA_FEED')).toMatchObject({ value: 'sip' })
    expect([...environment.keys()].filter((name) => /BROKER|TIGERBEETLE|CAPITAL/.test(name))).toEqual([])
  })

  test('limits database authority to the three append-only publication tables', () => {
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
    ])
    expect(users['bayn/grants/query']).toEqual([
      'GRANT SELECT ON signal.adjusted_daily_bars_v1',
      'GRANT SELECT ON signal.adjusted_daily_bars_v2',
      'GRANT SELECT ON signal.exchange_sessions_v1',
      'GRANT SELECT ON signal.snapshot_manifests_v1',
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
    expect(migration.match(/ENGINE = ReplicatedMergeTree/g)).toHaveLength(3)
    expect(kustomization.resources).toEqual(
      expect.arrayContaining([
        'signal-publisher-sealed-secret.yaml',
        'signal-schema-job.yaml',
        'signal-publisher-cronjob.yaml',
      ]),
    )
  })
})
