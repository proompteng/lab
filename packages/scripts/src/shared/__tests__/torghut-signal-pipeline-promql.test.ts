import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

interface Rule {
  alert: string
  expr: string
  for: string
  keep_firing_for?: string
  labels: Record<string, string>
  annotations: Record<string, string>
}

test('signal pipeline alerts detect missing telemetry and failed jobs without duplicate outage pages', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const groups = YAML.parse(manifest.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; rules: Rule[] }[]
  }
  const rules = groups.groups.find(({ name }) => name === 'torghut-ta.rules')?.rules
  if (!rules || rules.length !== 3) throw new Error('All three signal pipeline alerts are required')
  const names = rules.map(({ alert }) => alert)
  expect(names).toEqual([
    'TorghutSignalPipelineMetricsDown',
    'TorghutSignalPipelineNotRunning',
    'TorghutSignalPipelineCheckpointsStalled',
  ])
  for (const rule of rules) {
    expect(rule.labels).toEqual({ severity: 'critical', team: 'trading', notify: 'email' })
  }
  const services = ['torghut-ta-metrics', 'market-data-archive-metrics']
  const series = (service: string, up: string | null, running: string | null, checkpoint: string | null) => {
    const scope = `job="torghut",namespace="torghut",service="${service}",instance="a"`
    return [
      ['up', up],
      ['flink_jobmanager_numRunningJobs', running],
      ['flink_jobmanager_job_lastCheckpointCompletedTimestamp', checkpoint],
    ].flatMap(([metric, values]) => (values === null ? [] : [{ series: `${metric}{${scope}}`, values }]))
  }
  const expected = (rule: Rule, service: string) => ({
    exp_labels: { job: 'torghut', namespace: 'torghut', service, ...rule.labels },
    exp_annotations: Object.fromEntries(
      Object.entries(rule.annotations).map(([key, value]) => [key, value.replaceAll('{{ $labels.service }}', service)]),
    ),
  })
  const scenarios = [
    {
      name: 'healthy idle job still checkpoints',
      up: '1+0x24',
      running: '1+0x24',
      checkpoint: '0+30000x24',
      firing: -1,
    },
    {
      name: 'reachable JobManager with failed application driver',
      up: '1+0x24',
      running: '0+0x24',
      checkpoint: null,
      firing: 1,
    },
    { name: 'reachable JobManager loses job-count metric', up: '1+0x24', running: null, checkpoint: null, firing: 1 },
    { name: 'scrape is down', up: '0+0x24', running: null, checkpoint: null, firing: 0 },
    { name: 'scrape target disappears', up: null, running: null, checkpoint: null, firing: 0 },
    { name: 'running job loses checkpoint metric', up: '1+0x24', running: '1+0x24', checkpoint: null, firing: 2 },
    {
      name: 'running job has zero checkpoint timestamp',
      up: '1+0x24',
      running: '1+0x24',
      checkpoint: '0+0x24',
      firing: 2,
    },
    {
      name: 'checkpoint timestamp stops advancing',
      up: '1+0x24',
      running: '1+0x24',
      checkpoint: '30000+0x24',
      firing: 2,
    },
    {
      name: 'brief startup does not page',
      up: '1+0x24',
      running: '0 0 0 1+0x21',
      checkpoint: '0+30000x24',
      firing: -1,
    },
    {
      name: 'brief scrape failure does not page',
      up: '0 0 0 1+0x21',
      running: '1+0x24',
      checkpoint: '0+30000x24',
      firing: -1,
    },
  ]
  const cases = services.flatMap((service) =>
    scenarios.map((scenario) => ({
      name: `${service}: ${scenario.name}`,
      interval: '30s',
      input_series: services.flatMap((other) =>
        other === service
          ? series(other, scenario.up, scenario.running, scenario.checkpoint)
          : series(other, '1+0x24', '1+0x24', '0+30000x24'),
      ),
      alert_rule_test: rules.flatMap((rule, index) => [
        { alertname: rule.alert, eval_time: '90s', exp_alerts: [] },
        {
          alertname: rule.alert,
          eval_time: '10m',
          exp_alerts: scenario.firing === index ? [expected(rule, service)] : [],
        },
      ]),
    })),
  )
  runPromql(rules, cases)
})

function runPromql(rules: Rule[], cases: unknown[]): void {
  const directory = mkdtempSync(join(tmpdir(), 'torghut-signal-pipeline-promql-'))
  try {
    writeFileSync(join(directory, 'rules.yaml'), YAML.stringify({ groups: [{ name: 'signal-pipelines', rules }] }))
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: ['rules.yaml'], evaluation_interval: '30s', tests: cases }),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`Real PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('daily publication alert detects missed schedules and resolves after recovery without weekend pages', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const groups = YAML.parse(manifest.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; rules: Rule[] }[]
  }
  const rule = groups.groups
    .find(({ name }) => name === 'signal-publications.rules')
    ?.rules.find(({ alert }) => alert === 'SignalAdjustedDailyPublicationMissed')
  if (!rule) throw new Error('Daily publication deadline alert is required')
  expect(rule.for).toBe('5m')
  expect(rule.labels).toEqual({ severity: 'warning', team: 'trading', notify: 'email' })
  const expected = {
    exp_labels: { namespace: 'torghut', cronjob: 'signal-adjusted-daily-publisher', ...rule.labels },
    exp_annotations: rule.annotations,
  }
  const scenarios = [
    { name: 'failed run after earlier success', scheduled: true, success: '900+0x4320', firing: true },
    { name: 'first scheduled run fails', scheduled: true, success: null, firing: true },
    { name: 'scheduled run succeeds', scheduled: true, success: '1100+0x4320', firing: false },
    { name: 'no run has been scheduled yet', scheduled: false, success: null, firing: false },
    { name: 'owned recovery completes', scheduled: true, success: '900+0x150 9060+0x4169', firing: true },
  ]
  const cases = scenarios.map((scenario) => ({
    name: scenario.name,
    interval: '1m',
    input_series: ['a', 'b'].flatMap((instance) => {
      const scope = `namespace="torghut",cronjob="signal-adjusted-daily-publisher",instance="${instance}"`
      return [
        { series: `kube_cronjob_created{${scope}}`, values: '100+0x4320' },
        ...(scenario.scheduled
          ? [{ series: `kube_cronjob_status_last_schedule_time{${scope}}`, values: '1000+0x4320' }]
          : []),
        ...(scenario.success === null
          ? []
          : [{ series: `kube_cronjob_status_last_successful_time{${scope}}`, values: scenario.success }]),
      ]
    }),
    alert_rule_test: [
      { alertname: rule.alert, eval_time: '120m', exp_alerts: [] },
      { alertname: rule.alert, eval_time: '150m', exp_alerts: scenario.firing ? [expected] : [] },
      {
        alertname: rule.alert,
        eval_time: scenario.name === 'scheduled run succeeds' ? '3d' : '160m',
        exp_alerts: scenario.firing && scenario.name !== 'owned recovery completes' ? [expected] : [],
      },
    ],
  }))
  runPromql([rule], cases)
})

test('cluster collector retains the CronJob timestamps needed to detect a missed publication', () => {
  const config = readFileSync(
    new URL('../../../../../argocd/applications/observability/cluster-metrics-alloy-config.river', import.meta.url),
    'utf8',
  )
  const expression = config
    .split('\n')
    .find((line) => line.includes('|kube_cronjob_created|'))
    ?.match(/"(.+)"/)?.[1]
  if (!expression) throw new Error('Kubernetes metric allowlist is required')
  const allowlist = new RegExp(`^(?:${expression})$`)
  for (const metric of [
    'kube_cronjob_created',
    'kube_cronjob_status_last_schedule_time',
    'kube_cronjob_status_last_successful_time',
  ]) {
    expect(allowlist.test(`${metric};torghut;`)).toBe(true)
  }
  expect(allowlist.test('kube_job_status_failed;torghut;')).toBe(false)
})

test('Bayn readiness flaps remain one incident until five minutes of recovery', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  ) as { data: Record<string, string> }
  const groups = YAML.parse(manifest.data['graf-rules.yaml'] ?? '') as {
    groups: { name: string; rules: Rule[] }[]
  }
  const rule = groups.groups
    .find(({ name }) => name === 'bayn-cycle-operations.rules')
    ?.rules.find(({ alert }) => alert === 'BaynRuntimeDegraded')
  if (!rule) throw new Error('Bayn runtime alert is required')
  expect(rule.for).toBe('1m')
  expect(rule.keep_firing_for).toBe('5m')
  const scope = 'job="bayn",namespace="bayn",service="bayn",instance="a"'
  const expected = {
    exp_labels: { job: 'bayn', namespace: 'bayn', instance: 'a', ...rule.labels },
    exp_annotations: rule.annotations,
  }
  runPromql(
    [rule],
    [
      {
        name: 'detect sustained failure promptly, hold across short recoveries, then resolve',
        interval: '30s',
        input_series: [
          { series: `bayn_runtime_ready{${scope}}`, values: '0 0 0 0 1 1 0 0 1+0x20' },
          { series: `bayn_cycle_observation_available{${scope}}`, values: '1+0x28' },
          { series: `bayn_cycle_condition{${scope},condition="stalled"}`, values: '0+0x28' },
          { series: `bayn_cycle_condition{${scope},condition="failed"}`, values: '0+0x28' },
        ],
        alert_rule_test: [
          { alertname: rule.alert, eval_time: '30s', exp_alerts: [] },
          { alertname: rule.alert, eval_time: '90s', exp_alerts: [expected] },
          { alertname: rule.alert, eval_time: '150s', exp_alerts: [expected] },
          { alertname: rule.alert, eval_time: '510s', exp_alerts: [expected] },
          { alertname: rule.alert, eval_time: '10m', exp_alerts: [] },
        ],
      },
    ],
  )
})
