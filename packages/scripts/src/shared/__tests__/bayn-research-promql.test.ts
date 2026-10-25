import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'

test('research alerts distinguish paused workers, lost telemetry, failed attempts and unknown costs', () => {
  const config = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const document = YAML.parse(config.data['graf-rules.yaml'] ?? '') as {
    groups: {
      name: string
      rules: { alert: string; labels: Record<string, string>; annotations: Record<string, string> }[]
    }[]
  }
  const group = document.groups.find(({ name }) => name === 'bayn-research.rules')
  if (group?.rules.length !== 4) throw new Error('All four research alerts are required')
  const expected = (name: string) => {
    const rule = group.rules.find(({ alert }) => alert === name)
    if (rule === undefined) throw new Error(`Missing ${name}`)
    return { exp_labels: rule.labels, exp_annotations: rule.annotations }
  }
  const series = (name: string, values: string) => ({ series: name, values })
  const desired = (values = '1+0x30') =>
    series('kube_replicaset_spec_replicas{namespace="bayn",replicaset="bayn-research-v1"}', values)
  const heartbeat = series('bayn_research_worker_heartbeat_seconds', '0+60x30')
  const stale = 'BaynResearchWorkerStale'
  const failing = 'BaynResearchAttemptsFailing'
  const costs = 'BaynResearchCostCoverageIncomplete'
  const cases: Record<string, unknown>[] = []
  const check = (name: string, input: ReturnType<typeof series>[], fires: string[] = [], at = '20m') => {
    cases.push({
      name,
      interval: '1m',
      input_series: input,
      alert_rule_test: [stale, failing, costs].map((alertname) => ({
        alertname,
        eval_time: at,
        exp_alerts: fires.includes(alertname) ? [expected(alertname)] : [],
      })),
    })
  }
  check('healthy worker', [desired(), heartbeat])
  check('no desired worker', [])
  check('paused worker has no stale alert', [desired('0+0x30')])
  check('missing heartbeat while worker is desired', [desired()], [stale])
  check(
    'retired revision does not hide a missing heartbeat',
    [desired(), series('kube_replicaset_spec_replicas{namespace="bayn",replicaset="bayn-research-v0"}', '0+0x30')],
    [stale],
  )
  check('stopped heartbeat', [desired(), series('bayn_research_worker_heartbeat_seconds', '0+0x30')], [stale])
  check('missing heartbeat stays pending before five minutes', [desired()], [], '4m')
  check('heartbeat recovery clears stale alert', [
    desired(),
    series('bayn_research_worker_heartbeat_seconds', '0+0x10 660+60x19'),
  ])
  check(
    'three failures in the window',
    [desired(), heartbeat, series('bayn_research_attempts{outcome="EXPIRED"}', '0+1x30')],
    [failing],
  )
  check('successful attempts do not count as failures', [
    desired(),
    heartbeat,
    series('bayn_research_attempts{outcome="COMPLETE"}', '0+1x30'),
  ])
  check('one failure does not alert', [
    desired(),
    heartbeat,
    series('bayn_research_attempts{outcome="REJECTED"}', '0 1+0x29'),
  ])
  for (const metric of ['bayn_research_unpriced_attempts', 'bayn_research_ambiguous_attempts']) {
    check(`${metric} blocks cost qualification`, [desired(), heartbeat, series(metric, '1+0x30')], [costs])
    check(`${metric} must persist for ten minutes`, [desired(), heartbeat, series(metric, '1+0x30')], [], '9m')
  }
  check(
    'expense projection beyond five minutes',
    [desired(), heartbeat, series('bayn_research_oldest_pending_expense_seconds', '301+0x30')],
    [costs],
  )
  check('expense projection at five minutes is within budget', [
    desired(),
    heartbeat,
    series('bayn_research_oldest_pending_expense_seconds', '300+0x30'),
  ])
  check('verified cost coverage', [
    desired(),
    heartbeat,
    ...[
      'bayn_research_unpriced_attempts',
      'bayn_research_ambiguous_attempts',
      'bayn_research_oldest_pending_expense_seconds',
    ].map((metric) => series(metric, '0+0x30')),
  ])
  const publicStale = 'BaynPublicInformationStale'
  const publicCheck = (name: string, input: ReturnType<typeof series>[], sources: string[] = [], at = '20m') => {
    const rule = expected(publicStale)
    cases.push({
      name,
      interval: '1m',
      input_series: input,
      alert_rule_test: [
        {
          alertname: publicStale,
          eval_time: at,
          exp_alerts: sources.map((source) => ({ ...rule, exp_labels: { ...rule.exp_labels, source } })),
        },
      ],
    })
  }
  const enabled = series('bayn_public_information_enabled', '1+0x300')
  const freshSource = (source: string) =>
    series(`bayn_public_information_last_success_timestamp_seconds{source="${source}"}`, '0+60x300')
  publicCheck('public jobs not deployed', [])
  publicCheck('public jobs disabled', [series('bayn_public_information_enabled', '0+0x300')])
  publicCheck('both enabled public jobs missing', [enabled], ['SEC_FILINGS', 'MACRO_CALENDAR'])
  publicCheck('fresh public jobs', [enabled, freshSource('SEC_FILINGS'), freshSource('MACRO_CALENDAR')])
  publicCheck(
    'only filings stale',
    [
      enabled,
      series('bayn_public_information_last_success_timestamp_seconds{source="SEC_FILINGS"}', '0+0x300'),
      freshSource('MACRO_CALENDAR'),
    ],
    ['SEC_FILINGS'],
    '120m',
  )
  publicCheck(
    'only macro stale',
    [
      enabled,
      freshSource('SEC_FILINGS'),
      series('bayn_public_information_last_success_timestamp_seconds{source="MACRO_CALENDAR"}', '0+0x300'),
    ],
    ['MACRO_CALENDAR'],
    '210m',
  )
  const directory = mkdtempSync(join(tmpdir(), 'bayn-research-promql-'))
  try {
    writeFileSync(join(directory, 'rules.yaml'), YAML.stringify({ groups: [group] }))
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: ['rules.yaml'], evaluation_interval: '1m', tests: cases }),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`Real PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
