import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const costMetrics = [
  'bayn_research_unpriced_attempts',
  'bayn_research_ambiguous_attempts',
  'bayn_research_oldest_pending_expense_seconds',
]

const costDescription = (name: string, unpriced = 'unavailable', ambiguous = 'unavailable', lag = 'unavailable') =>
  `Unpriced retained attempts: ${unpriced}; ambiguous claims: ${ambiguous}; oldest pending priced expense: ${lag} seconds. ` +
  (name === 'BaynResearchCostCoverageIncomplete'
    ? 'Unpriced evidence can be historical and is not an expense-projection backlog. Unknown costs prevent a fully costed comparison; inspect immutable run allocation and receipt evidence before any recovery.'
    : 'Unpriced attempts increased within the last hour, claims are ambiguous, or priced expenses remain unposted. Inspect the worker and immutable allocation evidence; never substitute a zero price for an unknown cost.')

const researchGroup = () => {
  const config = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const document = YAML.parse(config.data['graf-rules.yaml'] ?? '') as {
    groups: {
      name: string
      rules: {
        alert: string
        expr: string
        for: string
        labels: Record<string, string>
        annotations: Record<string, string>
      }[]
    }[]
  }
  const group = document.groups.find(({ name }) => name === 'bayn-research.rules')
  if (group?.rules.length !== 4) throw new Error('All four research alerts are required')
  return group
}

test('research cost diagnostics distinguish retained debt from current degradation', () => {
  const group = researchGroup()
  for (const [name, severity] of [
    ['BaynResearchCostCoverageIncomplete', 'info'],
    ['BaynResearchCostCoverageDegraded', 'warning'],
  ]) {
    const rule = group.rules.find(({ alert }) => alert === name)
    if (rule === undefined) throw new Error(`Missing ${name}`)
    expect(rule.for).toBe('10m')
    expect(rule.labels).toEqual({ severity, team: 'platform', namespace: 'bayn', service: 'bayn-research' })
    expect(rule.annotations.runbook_url).toBe('docs/bayn/jev-optimization.md#research-cost-coverage-triage')
    for (const metric of costMetrics) {
      expect(rule.annotations.description).toContain(`with query "max(${metric})"`)
    }
    expect(rule.annotations.description.match(/else }}unavailable/g)).toHaveLength(3)
  }
})

test('research alerts distinguish paused workers, lost telemetry, failed attempts and unknown costs', () => {
  const group = researchGroup()
  const expected = (name: string, diagnostics: string[] = []) => {
    const rule = group.rules.find(({ alert }) => alert === name)
    if (rule === undefined) throw new Error(`Missing ${name}`)
    return {
      exp_labels: rule.labels,
      exp_annotations:
        name === 'BaynResearchCostCoverageIncomplete' || name === 'BaynResearchCostCoverageDegraded'
          ? { ...rule.annotations, description: costDescription(name, diagnostics[0], diagnostics[1], diagnostics[2]) }
          : rule.annotations,
    }
  }
  const series = (name: string, values: string) => ({ series: name, values })
  const desired = (values = '1+0x30') =>
    series('kube_replicaset_spec_replicas{namespace="bayn",replicaset="bayn-research-v1"}', values)
  const heartbeat = series('bayn_research_worker_heartbeat_seconds', '0+60x30')
  const stale = 'BaynResearchWorkerStale'
  const failing = 'BaynResearchAttemptsFailing'
  const costs = 'BaynResearchCostCoverageIncomplete'
  const degraded = 'BaynResearchCostCoverageDegraded'
  const cases: Record<string, unknown>[] = []
  const check = (
    name: string,
    input: ReturnType<typeof series>[],
    fires: string[] = [],
    at = '20m',
    diagnostics: string[] = [],
  ) => {
    cases.push({
      name,
      interval: '1m',
      input_series: input,
      alert_rule_test: [stale, failing, costs, degraded].map((alertname) => ({
        alertname,
        eval_time: at,
        exp_alerts: fires.includes(alertname) ? [expected(alertname, diagnostics)] : [],
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
    check(
      `${metric} blocks cost qualification while other coverage telemetry is unavailable`,
      [desired(), heartbeat, series(metric, '1+0x30')],
      [metric === 'bayn_research_unpriced_attempts' ? costs : degraded],
      '20m',
      metric === 'bayn_research_unpriced_attempts' ? ['1'] : ['unavailable', '1'],
    )
    check(`${metric} must persist for ten minutes`, [desired(), heartbeat, series(metric, '1+0x30')], [], '9m')
  }
  check(
    'expense projection beyond five minutes',
    [desired(), heartbeat, series('bayn_research_oldest_pending_expense_seconds', '301+0x30')],
    [degraded],
    '20m',
    ['unavailable', 'unavailable', '301'],
  )
  check(
    'historical missing allocation is distinct from a priced-expense backlog across worker replicas',
    [
      desired(),
      heartbeat,
      series('bayn_research_unpriced_attempts{instance="a"}', '69+0x30'),
      series('bayn_research_unpriced_attempts{instance="b"}', '69+0x30'),
      series('bayn_research_ambiguous_attempts', '0+0x30'),
      series('bayn_research_oldest_pending_expense_seconds', '0+0x30'),
    ],
    [costs],
    '20m',
    ['69', '0', '0'],
  )
  check(
    'all cost coverage causes remain independently visible',
    [
      desired(),
      heartbeat,
      series('bayn_research_unpriced_attempts', '2+0x30'),
      series('bayn_research_ambiguous_attempts', '3+0x30'),
      series('bayn_research_oldest_pending_expense_seconds', '600+0x30'),
    ],
    [costs, degraded],
    '20m',
    ['2', '3', '600'],
  )
  check('resolved cost gaps clear without changing the alert gate', [
    desired(),
    heartbeat,
    series('bayn_research_unpriced_attempts', '1+0x12 0+0x17'),
  ])
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
  const increasingUnknown = [desired(), heartbeat, series('bayn_research_unpriced_attempts', '69+0x14 70+0x15')]
  check('new unknown cost stays pending for ten minutes', increasingUnknown, [costs], '24m', ['70'])
  check('new unknown cost warns after ten minutes', increasingUnknown, [costs, degraded], '25m', ['70'])
  check(
    'new unknown cost warns with duplicate worker views',
    [
      desired(),
      heartbeat,
      series('bayn_research_unpriced_attempts{instance="a"}', '69+0x14 70+0x15'),
      series('bayn_research_unpriced_attempts{instance="b"}', '69+0x14 70+0x15'),
    ],
    [costs, degraded],
    '25m',
    ['70'],
  )
  check(
    'replacing a worker preserves the shared store baseline',
    [
      desired(),
      heartbeat,
      series('bayn_research_unpriced_attempts{instance="old"}', '69+0x10 stale _x19'),
      series('bayn_research_unpriced_attempts{instance="new"}', '_x10 69+0x20'),
    ],
    [costs],
    '25m',
    ['69'],
  )
  check(
    'a decreasing retained count does not create a recent-cost warning',
    [desired(), heartbeat, series('bayn_research_unpriced_attempts', '69+0x5 68+0x24')],
    [costs],
    '25m',
    ['68'],
  )
  check(
    'a stale worker does not hide retained cost debt',
    [desired(), series('bayn_research_unpriced_attempts', '69+0x30')],
    [stale, costs],
    '20m',
    ['69'],
  )
  check(
    'recent-cost warning clears after the one-hour detection window but retained debt remains',
    [
      desired('1+0x100'),
      series('bayn_research_worker_heartbeat_seconds', '0+60x100'),
      series('bayn_research_unpriced_attempts', '69+0x5 70+0x95'),
    ],
    [costs],
    '90m',
    ['70'],
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
