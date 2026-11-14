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

test('controller overdue distinguishes an absent due time from a missed durable deadline', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const config = YAML.parse(manifest.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; interval: string; rules: Rule[] }[]
  }
  const group = config.groups.find((g) => g.name === 'bayn-cycle-operations.rules')
  const rule = group?.rules.find((r) => r.alert === 'BaynExecutionControllerOverdue')
  if (group === undefined || rule === undefined) throw Error('Missing controller overdue rule')
  expect(rule.for).toBe('1m')
  const scope = 'job="bayn",namespace="bayn",service="bayn",instance="api-a"'
  const series = (active: string, due: string | null, completed: string | null) => [
    { series: `bayn_execution_controller_active{${scope}}`, values: active },
    { series: `bayn_cycle_stall_threshold_seconds{${scope}}`, values: '120+0x24' },
    ...(due === null
      ? []
      : [{ series: `bayn_execution_controller_next_due_timestamp_seconds{${scope}}`, values: due }]),
    ...(completed === null
      ? []
      : [{ series: `bayn_execution_controller_last_completion_timestamp_seconds{${scope}}`, values: completed }]),
  ]
  const alert = { exp_labels: { job: 'bayn', namespace: 'bayn', ...rule.labels }, exp_annotations: rule.annotations }
  const cases = [
    ['zero due and fresh completions remain healthy', '1+0x24', '0+0x24', '0+30x24', false],
    ['missing due and fresh completions remain healthy', '1+0x24', null, '0+30x24', false],
    ['zero due with stalled completions fires', '1+0x24', '0+0x24', '1+0x24', true],
    ['missing due with stalled completions fires', '1+0x24', null, '1+0x24', true],
    ['an explicit future due time permits a planned sleep', '1+0x24', '900+0x24', '1+0x24', false],
    ['an explicit missed deadline fires despite a recent completion', '1+0x24', '1+0x24', '0+30x24', true],
    ['a stopped controller does not fire', '0+0x24', '1+0x24', '1+0x24', false],
    ['an absent completion and due remain unknown', '1+0x24', null, null, false],
    ['zero completion and due remain unknown', '1+0x24', '0+0x24', '0+0x24', false],
  ] as const
  const tests = cases.map(([name, active, due, completed, fires]) => ({
    name,
    interval: '30s',
    input_series: series(active, due, completed),
    promql_expr_test: [
      {
        expr: rule.expr,
        eval_time: '10m',
        exp_samples: fires ? [{ labels: '{job="bayn",namespace="bayn",service="bayn"}', value: 1 }] : [],
      },
    ],
    alert_rule_test: [{ alertname: rule.alert, eval_time: '10m', exp_alerts: fires ? [alert] : [] }],
  }))
  const directory = mkdtempSync(join(tmpdir(), 'bayn-controller-overdue-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: group.name, interval: group.interval, rules: [rule] }] }),
    )
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: ['rules.yaml'], evaluation_interval: group.interval, tests }),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30000,
    })
    if (result.error !== undefined || result.status !== 0)
      throw Error(`PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
