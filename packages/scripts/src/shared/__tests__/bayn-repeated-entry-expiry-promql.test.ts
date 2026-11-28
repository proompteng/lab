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

const metrics = {
  reason: 'bayn_cycle_terminal_reason{reason="blocked_unused_entry_expired"}',
  terminal: 'bayn_cycle_last_terminal_timestamp_seconds',
  available: 'bayn_cycle_observation_available',
  up: 'up',
  open: 'bayn_cycle_submission_open_timestamp_seconds',
  cutoff: 'bayn_cycle_submission_cutoff_timestamp_seconds',
  projection: 'bayn_runtime_projection_timestamp_seconds',
} as const
type Metric = keyof typeof metrics
const defaults: Record<Metric, string> = {
  reason: '1+0x24',
  terminal: '0+30x24',
  available: '1+0x24',
  up: '1+0x24',
  open: '0+0x24',
  cutoff: '3600+0x24',
  projection: '0+30x24',
}
const series = (overrides: Partial<Record<Metric, string | null>> = {}, instance = 'a') =>
  (Object.keys(metrics) as Metric[]).flatMap((key) => {
    const values = { ...defaults, ...overrides }[key]
    if (values === null) return []
    const metric = metrics[key]
    const scope = `job="bayn",namespace="bayn",service="bayn",instance="${instance}"`
    return [{ series: metric.includes('{') ? metric.replace('{', `{${scope},`) : `${metric}{${scope}}`, values }]
  })

test('repeated entry expiry survives ready-state churn without joining different replicas', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const config = YAML.parse(manifest.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; interval: string; rules: Rule[] }[]
  }
  const group = config.groups.find(({ name }) => name === 'bayn-cycle-operations.rules')
  const rule = group?.rules.find(({ alert }) => alert === 'BaynRepeatedEntryExpiry')
  if (group === undefined || rule === undefined) throw new Error('Missing repeated Bayn expiry rule')
  expect(rule.for).toBe('1m')
  expect(rule.labels).toEqual({ severity: 'warning', team: 'trading', service: 'bayn', notify: 'email' })
  const sample = { labels: '{job="bayn",namespace="bayn",service="bayn"}', value: 1 }
  const alert = { exp_labels: { job: 'bayn', namespace: 'bayn', ...rule.labels }, exp_annotations: rule.annotations }
  const cases: Record<string, unknown>[] = []
  const check = (name: string, inputs: ReturnType<typeof series>, fires: boolean) => {
    cases.push({
      name,
      interval: '30s',
      input_series: inputs,
      promql_expr_test: [{ expr: rule.expr, eval_time: '10m', exp_samples: fires ? [sample] : [] }],
      alert_rule_test: [{ alertname: rule.alert, eval_time: '10m', exp_alerts: fires ? [alert] : [] }],
    })
  }
  check('repeated expired attempts fire independently of instantaneous readiness', series(), true)
  check('one expired cycle is not repeated failure', series({ terminal: '30+0x24' }), false)
  check('fewer than five observed transitions are insufficient', series({ terminal: '0 30 60 90+0x21' }), false)
  check('an observed completed or no-trade cycle breaks the expiry streak', series({ reason: '1+0x9 0 1+0x14' }), false)
  check('ordinary abstention is not repeated expiry', series({ reason: '0+0x24' }), false)
  check('the submission window has not opened', series({ open: '601+0x24' }), false)
  check('the submission cutoff is exclusive', series({ cutoff: '600+0x24' }), false)
  check('a failed scrape cannot establish current failure', series({ up: '0+0x24' }), false)
  check('an unavailable cycle projection remains unknown', series({ available: '0+0x24' }), false)
  check('a stale projection cannot establish a current streak', series({ projection: '0+0x24' }), false)
  check('a future-dated projection cannot hide stale evidence', series({ projection: '6+30x24' }), false)
  check('both valid replicas produce one service alert', [...series(), ...series({}, 'b')], true)
  check('a healthy peer does not erase a failing replica', [...series(), ...series({ reason: '0+0x24' }, 'b')], true)
  check(
    'terminal changes cannot be borrowed from another replica',
    [...series({ terminal: '0+0x24' }), ...series({ reason: '0+0x24' }, 'b')],
    false,
  )
  for (const key of Object.keys(metrics) as Metric[]) check(`missing ${key} is unknown`, series({ [key]: null }), false)
  for (const key of ['up', 'available', 'projection'] as const)
    check(
      `an expired replica cannot borrow a peer's ${key}`,
      [...series({ [key]: '0+0x24' }), ...series({ terminal: '0+0x24' }, 'b')],
      false,
    )
  const directory = mkdtempSync(join(tmpdir(), 'bayn-repeated-entry-expiry-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: group.name, interval: group.interval, rules: [rule] }] }),
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
    if (result.error !== undefined || result.status !== 0)
      throw new Error(`PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
