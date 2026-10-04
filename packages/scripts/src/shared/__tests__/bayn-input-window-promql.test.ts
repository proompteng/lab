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
  input: 'bayn_execution_session_condition{condition="input_unavailable"}',
  phase: 'bayn_cycle_phase{phase="active"}',
  bound: 'bayn_cycle_decision_bound',
  first: 'bayn_cycle_first_observation_timestamp_seconds',
  cutoff: 'bayn_cycle_submission_cutoff_timestamp_seconds',
  runtime: 'bayn_runtime_ready',
  observation: 'bayn_cycle_observation_available',
  up: 'up',
  ready: 'bayn_execution_session_ready',
  activation: 'bayn_capital_activation_state{state="realized"}',
  open: 'bayn_cycle_submission_open_timestamp_seconds',
  lagging: 'bayn_execution_session_condition{condition="decision_lagging"}',
} as const
type Metric = keyof typeof metrics
type Values = Partial<Record<Metric, string | null>>
const defaults: Record<Metric, string> = {
  input: '1+0x10',
  phase: '1+0x10',
  bound: '0+0x10',
  first: '60+0x10',
  cutoff: '600+0x10',
  runtime: '1+0x10',
  observation: '1+0x10',
  up: '1+0x10',
  ready: '0+0x10',
  activation: '1+0x10',
  open: '0+0x10',
  lagging: '0+0x10',
}
const series = (overrides: Values = {}, instance = 'a', identity = scope) =>
  (Object.keys(metrics) as Metric[]).flatMap((key) => {
    const values = { ...defaults, ...overrides }[key]
    if (values === null) return []
    const metric = metrics[key]
    const labels = `${identity},instance="${instance}"`
    return [
      {
        series: metric.includes('{') ? metric.replace('{', `{${labels},`) : `${metric}{${labels}}`,
        values,
      },
    ]
  })

test('evaluates input-window gates, replica identity, de-duplication and alert duration with real PromQL', () => {
  const config = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const groups = YAML.parse(config.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; rules: Rule[] }[]
  }
  const selected = groups.groups
    .find(({ name }) => name === 'bayn-cycle-operations.rules')
    ?.rules.filter(({ alert }) => ['BaynInputWindowUnavailable', 'BaynExecutionWindowUnready'].includes(alert))
  if (selected?.length !== 2) throw new Error('Both input-window alert rules are required')
  const input = selected.find(({ alert }) => alert === 'BaynInputWindowUnavailable')
  const generic = selected.find(({ alert }) => alert === 'BaynExecutionWindowUnready')
  if (input === undefined || generic === undefined) throw new Error('Missing alert rule')
  expect(input.for).toBe('1m')
  expect(input.labels).toEqual({ severity: 'warning', team: 'trading', service: 'bayn', notify: 'email' })

  const sample = { labels: '{job="bayn",namespace="bayn",service="bayn"}', value: 1 }
  const alert = (rule: Rule) => ({
    exp_labels: { job: 'bayn', namespace: 'bayn', ...rule.labels },
    exp_annotations: rule.annotations,
  })
  const cases: Record<string, unknown>[] = []
  const check = (name: string, values: ReturnType<typeof series>, fires: boolean, genericFires = false, at = '2m') => {
    cases.push({
      name,
      interval: '30s',
      input_series: values,
      promql_expr_test: [
        { expr: input.expr, eval_time: at, exp_samples: fires ? [sample] : [] },
        { expr: generic.expr, eval_time: at, exp_samples: genericFires ? [sample] : [] },
      ],
      alert_rule_test: [
        { alertname: input.alert, eval_time: at, exp_alerts: fires ? [alert(input)] : [] },
        { alertname: generic.alert, eval_time: at, exp_alerts: genericFires ? [alert(generic)] : [] },
      ],
    })
  }

  check('complete gate set fires only the dedicated input alert', series(), true)
  check('healthy inputs', series({ input: '0+0x10', ready: '1+0x10' }), false)
  check('preopen and warmup despite an old input condition', series({ first: '180+0x10' }), false, true)
  check('submission cutoff is exclusive', series({ cutoff: '120+0x10' }), false)
  check('bound decisions need no new entry window', series({ bound: '1+0x10' }), false)
  check('inactive cycle', series({ phase: '0+0x10' }), false)
  check('stale runtime projection closes runtime readiness', series({ runtime: '0+0x10' }), false, true)
  check('unknown cycle projection', series({ observation: '0+0x10' }), false, true)
  check('failed scrape cannot establish the specific input failure', series({ up: '0+0x10' }), false, true)
  check('ordinary abstention', series({ input: '0+0x10', ready: '1+0x10' }), false)
  check('decision lag retains its dedicated route', series({ input: '0+0x10', lagging: '1+0x10' }), false)
  check('another readiness failure keeps the generic notification', series({ input: '0+0x10' }), false, true)
  check('missing telemetry remains unknown', [], false)
  check(
    'stale series do not fabricate recovery or failure',
    series(
      Object.fromEntries(
        (Object.keys(metrics) as Metric[]).map((key) => [key, `${defaults[key]?.split('+')[0]}+0x2 stale`]),
      ),
    ),
    false,
  )
  for (const key of ['input', 'phase', 'bound', 'first', 'cutoff', 'runtime', 'observation', 'up'] as const) {
    check(
      `missing ${key} leaves the dedicated signal unknown without suppressing generic readiness`,
      series({ [key]: null }),
      false,
      ['input', 'first', 'runtime', 'observation', 'up'].includes(key),
    )
  }
  check(
    'healthy replica cannot mask a failing replica',
    [...series(), ...series({ input: '0+0x10', ready: '1+0x10' }, 'b')],
    true,
  )
  check(
    'different replica failure is not suppressed by input-window de-duplication',
    [...series(), ...series({ input: '0+0x10' }, 'b')],
    true,
    true,
  )
  check(
    'unhealthy input replica cannot borrow a healthy runtime',
    [...series({ runtime: '0+0x10' }), ...series({ input: '0+0x10', ready: '1+0x10' }, 'b')],
    false,
    true,
  )
  check(
    'input replica cannot borrow another replica cycle projection',
    [...series({ observation: '0+0x10' }), ...series({ input: '0+0x10', ready: '1+0x10' }, 'b')],
    false,
    true,
  )
  check(
    'input replica cannot borrow another replica scrape health',
    [...series({ up: '0+0x10' }), ...series({ input: '0+0x10', ready: '1+0x10' }, 'b')],
    false,
    true,
  )
  for (const label of ['job', 'namespace', 'service', 'instance']) {
    const wrong = series()
      .filter(({ series: metric }) => metric.startsWith('bayn_runtime_ready'))
      .map((item) => ({
        ...item,
        series: item.series.replace(`${label}="${label === 'instance' ? 'a' : 'bayn'}"`, `${label}="other"`),
      }))
    check(`runtime cannot join across ${label}`, [...series({ runtime: null }), ...wrong], false, true)
  }
  cases.push({
    name: 'first observation is inclusive and a full minute is required',
    interval: '30s',
    input_series: series(),
    promql_expr_test: [
      { expr: input.expr, eval_time: '30s', exp_samples: [] },
      { expr: input.expr, eval_time: '1m', exp_samples: [sample] },
    ],
    alert_rule_test: [
      { alertname: input.alert, eval_time: '1m', exp_alerts: [] },
      { alertname: input.alert, eval_time: '90s', exp_alerts: [] },
      { alertname: input.alert, eval_time: '2m', exp_alerts: [alert(input)] },
    ],
  })
  cases.push({
    name: 'recovery before the minute resets pending and clears the notification',
    interval: '30s',
    input_series: series({ input: '1 1 1 0 1 1 1 0 0' }),
    alert_rule_test: [
      { alertname: input.alert, eval_time: '90s', exp_alerts: [] },
      { alertname: input.alert, eval_time: '150s', exp_alerts: [] },
      { alertname: input.alert, eval_time: '3m', exp_alerts: [alert(input)] },
      { alertname: input.alert, eval_time: '210s', exp_alerts: [] },
    ],
  })
  const directory = mkdtempSync(join(tmpdir(), 'bayn-input-window-promql-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: 'bayn-input-window', rules: selected }] }),
    )
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({
        rule_files: ['rules.yaml'],
        evaluation_interval: '30s',
        tests: cases,
      }),
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
