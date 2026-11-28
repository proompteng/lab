import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

interface Rule {
  readonly alert: string
  readonly expr: string
  readonly for: string
  readonly labels: Record<string, string>
  readonly annotations: Record<string, string>
}

const scope = 'job="bayn",namespace="bayn",service="bayn"'
const metrics = {
  phase: 'bayn_cycle_phase{phase="active"}',
  bound: 'bayn_cycle_decision_bound',
  activation: 'bayn_capital_activation_state{state="realized"}',
  preflight: 'bayn_execution_session_preflight_ready',
  lagging: 'bayn_execution_session_condition{condition="decision_lagging"}',
  deadline: 'bayn_cycle_decision_deadline_timestamp_seconds',
  cutoff: 'bayn_cycle_submission_cutoff_timestamp_seconds',
  up: 'up',
} as const
type Metric = keyof typeof metrics
type Values = Partial<Record<Metric, string | null>>
const defaults: Record<Metric, string> = {
  phase: '1+0x10',
  bound: '0+0x10',
  activation: '1+0x10',
  preflight: '1+0x10',
  lagging: '1+0x10',
  deadline: '60+0x10',
  cutoff: '600+0x10',
  up: '1+0x10',
}
const series = (overrides: Values = {}, instance = 'a', identity = scope) =>
  (Object.keys(metrics) as Metric[]).flatMap((key) => {
    const values = { ...defaults, ...overrides }[key]
    if (values === null) return []
    const metric = metrics[key]
    const labels = `${identity},instance="${instance}"`
    return [{ series: metric.includes('{') ? metric.replace('{', `{${labels},`) : `${metric}{${labels}}`, values }]
  })

test('evaluates decision lag per replica before aggregation with real PromQL', () => {
  const config = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const groups = YAML.parse(config.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; interval: string; rules: Rule[] }[]
  }
  const group = groups.groups.find(({ name }) => name === 'bayn-cycle-operations.rules')
  const rule = group?.rules.find(({ alert }) => alert === 'BaynExecutionDecisionLagging')
  if (group === undefined || rule === undefined) throw new Error('Missing Bayn decision-lag rule')
  expect(group.interval).toBe('15s')
  expect(rule.for).toBe('1m')
  expect(rule.labels).toEqual({ severity: 'warning', team: 'trading', service: 'bayn', notify: 'email' })

  const sample = { labels: '{job="bayn",namespace="bayn",service="bayn"}', value: 1 }
  const alert = { exp_labels: { job: 'bayn', namespace: 'bayn', ...rule.labels }, exp_annotations: rule.annotations }
  const cases: Record<string, unknown>[] = []
  const check = (name: string, values: ReturnType<typeof series>, fires: boolean) => {
    cases.push({
      name,
      interval: '30s',
      input_series: values,
      promql_expr_test: [{ expr: rule.expr, eval_time: '2m', exp_samples: fires ? [sample] : [] }],
      alert_rule_test: [{ alertname: rule.alert, eval_time: '2m', exp_alerts: fires ? [alert] : [] }],
    })
  }

  check('eligible lagging replica fires', series(), true)
  // Both replicas have an unfinished ACTIVE cycle, so the exporter emits binding and timing gauges for each.
  check(
    'a peer with an already-bound decision cannot mask a lagging replica',
    [...series(), ...series({ bound: '1+0x10', lagging: '0+0x10' }, 'b')],
    true,
  )
  check(
    'a peer awaiting a later deadline cannot postpone another replica alert',
    [...series(), ...series({ lagging: '0+0x10', deadline: '180+0x10' }, 'b')],
    true,
  )
  check('multiple qualifying replicas produce one service alert', [...series(), ...series({}, 'b')], true)
  check('normal bound decision', series({ bound: '1+0x10', lagging: '0+0x10' }), false)
  check('not yet past the deadline', series({ lagging: '0+0x10', deadline: '180+0x10' }), false)
  check('submission cutoff is exclusive', series({ cutoff: '120+0x10' }), false)
  check('inactive cycle', series({ phase: '0+0x10' }), false)
  check('unrealized activation', series({ activation: '0+0x10' }), false)
  check('OBSERVE authority or stale durable projection closes preflight', series({ preflight: '0+0x10' }), false)
  check('input failure or abstention is not decision lag', series({ lagging: '0+0x10' }), false)
  check('a failed scrape cannot establish current decision lag', series({ up: '0+0x10' }), false)
  check('missing telemetry is unknown, not decision lag', [], false)
  check(
    'stale series cannot establish current decision lag',
    series(
      Object.fromEntries(
        (Object.keys(metrics) as Metric[]).map((key) => [key, `${defaults[key].split('+')[0]}+0x2 stale`]),
      ),
    ),
    false,
  )
  for (const key of Object.keys(metrics) as Metric[]) {
    check(`missing ${key} cannot establish the specific failure`, series({ [key]: null }), false)
  }
  for (const key of ['activation', 'preflight', 'up'] as const) {
    check(
      `a lagging replica cannot borrow another replica's ${key}`,
      [...series({ [key]: '0+0x10' }), ...series({ lagging: '0+0x10' }, 'b')],
      false,
    )
  }
  check(
    'a closed lagging replica cannot borrow another replica cutoff',
    [...series({ cutoff: '120+0x10' }), ...series({ lagging: '0+0x10' }, 'b')],
    false,
  )
  for (const label of ['job', 'namespace', 'service', 'instance']) {
    const foreign = series()
      .filter(({ series: metric }) => metric.startsWith('bayn_execution_session_preflight_ready'))
      .map((item) => ({
        ...item,
        series: item.series.replace(`${label}="${label === 'instance' ? 'a' : 'bayn'}"`, `${label}="other"`),
      }))
    check(`preflight cannot join across ${label}`, [...series({ preflight: null }), ...foreign], false)
  }
  cases.push({
    name: 'inclusive deadline, unchanged one-minute duration, and recovery',
    interval: '30s',
    input_series: series({ bound: '0 0 0 0 0 1 1', lagging: '0 0 1 1 1 0 0' }),
    promql_expr_test: [
      { expr: rule.expr, eval_time: '45s', exp_samples: [] },
      { expr: rule.expr, eval_time: '1m', exp_samples: [sample] },
    ],
    alert_rule_test: [
      { alertname: rule.alert, eval_time: '105s', exp_alerts: [] },
      { alertname: rule.alert, eval_time: '2m', exp_alerts: [alert] },
      { alertname: rule.alert, eval_time: '150s', exp_alerts: [] },
    ],
  })
  const directory = mkdtempSync(join(tmpdir(), 'bayn-decision-lag-promql-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: 'bayn-decision-lag', interval: group.interval, rules: [rule] }] }),
    )
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: ['rules.yaml'], evaluation_interval: group.interval, tests: cases }),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `Real PromQL evaluation requires promtool on PATH (or PROMTOOL): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
