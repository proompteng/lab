import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const scope = 'job="bayn",namespace="bayn",service="bayn"'
const observation = 'BaynCycleObservationUnavailable'
const scrape = 'BaynMetricsUnavailable'
const series = (available: string | null, up = '1+0x60', instance = 'a') => [
  { series: `up{${scope},instance="${instance}"}`, values: up },
  ...(available === null
    ? []
    : [{ series: `bayn_cycle_observation_available{${scope},instance="${instance}"}`, values: available }]),
]

test('missing cycle telemetry is distinct from valid idle cycles and failed scrapes', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  )
  const group = YAML.parse(manifest.data['graf-rules.yaml']).groups.find(
    (group: { name: string }) => group.name === 'bayn-cycle-operations.rules',
  )
  const rules = group.rules.filter((rule: { alert: string }) =>
    [observation, scrape, 'BaynCycleFailed', 'BaynCycleStalled'].includes(rule.alert),
  )
  expect(rules).toHaveLength(4)
  expect(group.interval).toBe('15s')
  expect(rules.find((rule: { alert: string }) => rule.alert === observation).for).toBe('2m')
  expect(rules.find((rule: { alert: string }) => rule.alert === observation).keep_firing_for).toBe('5m')
  const expected = (name: string) => {
    const rule = rules.find((rule: { alert: string }) => rule.alert === name)
    return {
      exp_labels: { job: 'bayn', namespace: 'bayn', ...rule.labels, ...(name === scrape ? { instance: 'a' } : {}) },
      exp_annotations: rule.annotations,
    }
  }
  const cases: Record<string, unknown>[] = []
  const check = (name: string, input: ReturnType<typeof series>, at: string, fires: string[] = []) =>
    cases.push({
      name,
      interval: '15s',
      input_series: input,
      alert_rule_test: rules.map((rule: { alert: string }) => ({
        alertname: rule.alert,
        eval_time: at,
        exp_alerts: fires.includes(rule.alert) ? [expected(rule.alert)] : [],
      })),
    })
  for (const phase of ['none', 'no_trade', 'completed']) {
    check(
      `healthy ${phase} needs no trading activity`,
      [
        ...series('1+0x60'),
        { series: `bayn_cycle_phase{${scope},instance="a",phase="${phase}"}`, values: '1+0x60' },
        { series: `bayn_cycle_condition{${scope},instance="a",condition="failed"}`, values: '0+0x60' },
        { series: `bayn_cycle_condition{${scope},instance="a",condition="stalled"}`, values: '0+0x60' },
      ],
      '3m',
    )
  }
  check('missing family remains pending before two minutes', series(null), '1m45s')
  check('missing family fires at two minutes', series(null), '2m', [observation])
  check('healthy replica cannot mask missing replica', [...series(null), ...series('1+0x60', '1+0x60', 'b')], '2m', [
    observation,
  ])
  check('explicit unavailable retains its existing behavior', series('0+0x60'), '2m', [observation])
  check('stale marker removes previously healthy observation', series('1+0x3 stale'), '3m', [observation])
  check('brief missing observation does not fire', series('1+0x3 stale _x2 1+0x50'), '3m')
  check('recovery retains existing five minute hold', series('0+0x8 1+0x51'), '6m', [observation])
  check('recovery clears after existing hold', series('0+0x8 1+0x51'), '8m')
  check('missing family recovery clears after existing hold', series('_x9 1+0x51'), '8m')
  check('failed scrape with missing family is only scrape unavailable', series(null, '0+0x60'), '2m', [scrape])
  check(
    'stale observation during failed scrape is only scrape unavailable',
    series('1+0x3 stale', '1+0x3 0+0x56'),
    '3m',
    [scrape],
  )
  const directory = mkdtempSync(join(tmpdir(), 'bayn-cycle-observation-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: group.name, interval: group.interval, rules }] }),
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
