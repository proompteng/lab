import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'

const runPromtool = (files: Readonly<Record<string, string>>) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-cache-promql-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content)
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error !== undefined || result.status !== 0)
      throw new Error(`Native PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('Bayn cache alerts evaluate healthy, missing, failed and low-traffic observations with native PromQL', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  )
  runPromtool({
    'rules.yaml': manifest.data['graf-rules.yaml'],
    'tests.yaml': readFileSync(
      new URL('../../../../../argocd/applications/observability/tests/bayn-cache-alerts.yaml', import.meta.url),
      'utf8',
    ),
  })
}, 30_000)

type MetricPanel = {
  readonly type: 'stat' | 'timeseries' | 'bargauge' | 'logs'
  readonly title: string
  readonly targets: readonly { readonly expr: string; readonly legendFormat?: string }[]
}
type DashboardPanel = MetricPanel | { readonly type: 'row'; readonly panels: readonly DashboardPanel[] }
const metricPanels = (panels: readonly DashboardPanel[]): readonly MetricPanel[] =>
  panels.flatMap((panel) => (panel.type === 'row' ? metricPanels(panel.panels) : [panel]))

test('Bayn dashboard evaluates replica health, telemetry freshness, waits and operation outcomes with native PromQL', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL(
        '../../../../../argocd/applications/observability/bayn-cache-performance-dashboard-configmap.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const dashboard: { readonly panels: readonly DashboardPanel[] } = JSON.parse(
    manifest.data['bayn-cache-performance.json'],
  )
  const panels = metricPanels(dashboard.panels)
  const replica = panels
    .flatMap((panel) => panel.targets)
    .find((target) => target.legendFormat === 'Replica link')?.expr
  const waits = panels.find((panel) => panel.title === 'Database I/O and lock waits')?.targets[0]?.expr
  const failures = panels.find((panel) => panel.title === 'Operation failures per second')?.targets[0]?.expr
  const setLatency = panels
    .flatMap((panel) => panel.targets)
    .find((target) => target.legendFormat === 'SET command')?.expr
  const snapshotBudget = panels.find((panel) => panel.title === 'Age / limit')?.targets[0]?.expr
  const cycles = panels.find((panel) => panel.title === 'Cycles / min')?.targets[0]?.expr
  const outcomes = panels.find((panel) => panel.title === 'Critical-path outcomes / min')?.targets
  if (
    replica === undefined ||
    waits === undefined ||
    failures === undefined ||
    setLatency === undefined ||
    snapshotBudget === undefined ||
    cycles === undefined ||
    outcomes === undefined
  )
    throw new Error('Required Bayn dashboard query is missing')
  const cacheSeries = (metric: string, pod: string, value: number) => ({
    series: `${metric}{job="bayn-valkey",namespace="bayn",pod="${pod}"}`,
    values: `${value}+0x10`,
  })
  const observations = [
    { name: 'both sides connected', primary: 1, replica: 1, primaryScrape: 1, expected: 1 },
    { name: 'primary sees no replica', primary: 0, replica: 1, primaryScrape: 1, expected: 0 },
    { name: 'replica link disconnected', primary: 1, replica: 0, primaryScrape: 1, expected: 0 },
    { name: 'primary exporter down with stale observation', primary: 1, replica: 1, primaryScrape: 0, expected: 0 },
    { name: 'primary observation missing', primary: null, replica: 1, primaryScrape: 1, expected: null },
    { name: 'replica observation missing', primary: 1, replica: null, primaryScrape: 1, expected: null },
  ]
  const tests = observations.map((observation) => ({
    name: observation.name,
    interval: '1m',
    input_series: [
      cacheSeries('up', 'primary', observation.primaryScrape),
      cacheSeries('up', 'replica', 1),
      ...(observation.primary === null ? [] : [cacheSeries('redis_connected_slaves', 'primary', observation.primary)]),
      ...(observation.replica === null ? [] : [cacheSeries('redis_master_link_up', 'replica', observation.replica)]),
    ],
    promql_expr_test: [
      {
        expr: replica,
        eval_time: '10m',
        exp_samples: observation.expected === null ? [] : [{ labels: '{}', value: observation.expected }],
      },
    ],
  }))
  const bufferPin =
    'cnpg_bayn_waits_backends{namespace="bayn",cluster="bayn-db",role="primary",wait_event_type="BufferPin",wait_event="BufferPin"}'
  const walSync =
    'cnpg_bayn_waits_backends{namespace="bayn",cluster="bayn-db",role="primary",wait_event_type="IO",wait_event="WALSync"}'
  tests.push({
    name: 'buffer pins and WAL waits remain visible while idle clients are excluded',
    interval: '1m',
    input_series: [
      { series: bufferPin, values: '2+0x10' },
      { series: walSync, values: '1+0x10' },
      {
        series:
          'cnpg_bayn_waits_backends{namespace="bayn",cluster="bayn-db",role="primary",wait_event_type="Client",wait_event="ClientRead"}',
        values: '9+0x10',
      },
    ],
    promql_expr_test: [
      {
        expr: waits,
        eval_time: '10m',
        exp_samples: [
          { labels: bufferPin, value: 2 },
          { labels: walSync, value: 1 },
        ],
      },
    ],
  })
  const source = 'a'.repeat(40)
  const bindSource = (query: string) =>
    query.replaceAll('$source_revision', source).replaceAll('$__rate_interval', '2m')
  for (const [service, legend] of [
    ['bayn', 'API data'],
    ['bayn-execution-controller', 'Worker data'],
  ]) {
    const heartbeat = panels.flatMap((panel) => panel.targets).find((target) => target.legendFormat === legend)?.expr
    if (heartbeat === undefined) throw new Error(`Missing ${legend} query`)
    for (const observation of [
      { name: 'five seconds ahead remains within clock tolerance', offsets: [0, 5], expected: 2 },
      { name: 'future-dated heartbeat is rejected', offsets: [0, 6], expected: 1 },
      { name: 'stale heartbeat is rejected', offsets: [0, -90], expected: 1 },
      { name: 'missing telemetry remains unknown', offsets: [], expected: null },
    ]) {
      tests.push({
        name: `${service}: ${observation.name}`,
        interval: '1m',
        input_series: [
          ...observation.offsets.map((offset, index) => ({
            series: `bayn_telemetry_heartbeat_timestamp_seconds{namespace="bayn",service="${service}",source_revision="${source}",pod="pod-${index}"}`,
            values: `${600 + offset}+0x10`,
          })),
          {
            series: `bayn_telemetry_heartbeat_timestamp_seconds{namespace="bayn",service="${service}",source_revision="${'b'.repeat(40)}",pod="old-source"}`,
            values: '600+0x10',
          },
        ],
        promql_expr_test: [
          {
            expr: bindSource(heartbeat),
            eval_time: '10m',
            exp_samples: observation.expected === null ? [] : [{ labels: '{}', value: observation.expected }],
          },
        ],
      })
    }
  }
  tests.push({
    name: 'failed and interrupted dependencies remain visible without successful or old-source operations',
    interval: '1m',
    input_series: [
      {
        series: `bayn_operation_duration_seconds_count{namespace="bayn",service="bayn",source_revision="${source}",dependency="postgres",outcome="failed"}`,
        values: '0+1x10',
      },
      {
        series: `bayn_operation_duration_seconds_count{namespace="bayn",service="bayn-execution-controller",source_revision="${source}",dependency="restate",outcome="interrupted"}`,
        values: '0+2x10',
      },
      {
        series: `bayn_operation_duration_seconds_count{namespace="bayn",service="bayn",source_revision="${source}",dependency="postgres",outcome="succeeded"}`,
        values: '0+100x10',
      },
      {
        series: `bayn_operation_duration_seconds_count{namespace="bayn",service="bayn",source_revision="${'b'.repeat(40)}",dependency="valkey",outcome="failed"}`,
        values: '0+50x10',
      },
    ],
    promql_expr_test: [
      {
        expr: bindSource(failures),
        eval_time: '10m',
        exp_samples: [
          { labels: '{dependency="postgres",outcome="failed"}', value: 1 / 60 },
          { labels: '{dependency="restate",outcome="interrupted"}', value: 2 / 60 },
        ],
      },
    ],
  })
  tests.push({
    name: 'SET latency is measured independently of the enclosing write and failed commands',
    interval: '1m',
    input_series: [
      ...[
        { le: '0.5', increment: 9 },
        { le: '+Inf', increment: 10 },
      ].map(({ le, increment }) => ({
        series: `bayn_operation_duration_seconds_bucket{namespace="bayn",service="bayn",source_revision="${source}",stage="bayn.valkey.set",outcome="succeeded",le="${le}"}`,
        values: `0+${increment}x10`,
      })),
      {
        series: `bayn_operation_duration_seconds_bucket{namespace="bayn",service="bayn",source_revision="${source}",stage="bayn.valkey.write",outcome="succeeded",le="+Inf"}`,
        values: '0+100x10',
      },
      {
        series: `bayn_operation_duration_seconds_bucket{namespace="bayn",service="bayn",source_revision="${source}",stage="bayn.valkey.set",outcome="failed",le="+Inf"}`,
        values: '0+100x10',
      },
    ],
    promql_expr_test: [
      {
        expr: bindSource(setLatency),
        eval_time: '10m',
        exp_samples: [{ labels: '{stage="bayn.valkey.set"}', value: 0.5 }],
      },
    ],
  })
  const pullSeries = (metric: string, instance: string, values: string) => ({
    series: `${metric}{job="bayn",namespace="bayn",service="bayn",instance="${instance}"}`,
    values,
  })
  for (const observation of [
    { name: 'snapshot within its configured budget', timestamp: 540, threshold: 120, up: 1, expected: 0.5 },
    { name: 'stale snapshot exceeds its configured budget', timestamp: 360, threshold: 120, up: 1, expected: 2 },
    { name: 'future snapshot remains unknown', timestamp: 601, threshold: 120, up: 1, expected: null },
    { name: 'missing freshness limit remains unknown', timestamp: 540, threshold: null, up: 1, expected: null },
    { name: 'invalid freshness limit remains unknown', timestamp: 540, threshold: 0, up: 1, expected: null },
    {
      name: 'failed API scrape cannot satisfy snapshot freshness',
      timestamp: 540,
      threshold: 120,
      up: 0,
      expected: null,
    },
  ]) {
    tests.push({
      name: observation.name,
      interval: '1m',
      input_series: [
        pullSeries(
          'bayn_broker_position_snapshot_observed_timestamp_seconds',
          'current',
          `${observation.timestamp}+0x10`,
        ),
        ...(observation.threshold === null
          ? []
          : [pullSeries('bayn_reconciliation_stale_threshold_seconds', 'current', `${observation.threshold}+0x10`)]),
        pullSeries('up', 'current', `${observation.up}+0x10`),
        {
          series: `bayn_build_info{job="bayn",namespace="bayn",service="bayn",instance="current",source_revision="${source}"}`,
          values: '1+0x10',
        },
        pullSeries('bayn_broker_position_snapshot_observed_timestamp_seconds', 'old', '360+0x10'),
        pullSeries('bayn_reconciliation_stale_threshold_seconds', 'old', '120+0x10'),
        pullSeries('up', 'old', '1+0x10'),
        {
          series: `bayn_build_info{job="bayn",namespace="bayn",service="bayn",instance="old",source_revision="${'b'.repeat(40)}"}`,
          values: '1+0x10',
        },
      ],
      promql_expr_test: [
        {
          expr: bindSource(snapshotBudget),
          eval_time: '10m',
          exp_samples: observation.expected === null ? [] : [{ labels: '{}', value: observation.expected }],
        },
      ],
    })
  }
  const operationSeries = (stage: string, outcome: string, increment: number, revision = source) => ({
    series: `bayn_operation_duration_seconds_count{namespace="bayn",service="bayn-execution-controller",source_revision="${revision}",stage="${stage}",outcome="${outcome}"}`,
    values: `0+${increment}x10`,
  })
  const rootOperations = [
    operationSeries('bayn.execution.cycle-pass', 'succeeded', 1),
    operationSeries('bayn.execution.cycle-pass', 'failed', 2),
    operationSeries('bayn.execution.cycle-pass', 'interrupted', 3),
    operationSeries('bayn.execution.bounded-pass', 'failed', 100),
    operationSeries('bayn.broker.observation.poll', 'succeeded', 4),
    operationSeries('bayn.broker.observation.poll', 'failed', 5),
    operationSeries('bayn.broker.observation.capture', 'failed', 100),
    operationSeries('bayn.execution.cycle-pass', 'succeeded', 100, 'b'.repeat(40)),
  ]
  tests.push({
    name: 'cycle activity counts successful root work without children or older sources',
    interval: '1m',
    input_series: rootOperations,
    promql_expr_test: [{ expr: bindSource(cycles), eval_time: '10m', exp_samples: [{ labels: '{}', value: 1 }] }],
  })
  for (const target of outcomes) {
    tests.push({
      name: `critical-path outcomes exclude nested work: ${target.legendFormat}`,
      interval: '1m',
      input_series: rootOperations,
      promql_expr_test: [
        {
          expr: bindSource(target.expr),
          eval_time: '10m',
          exp_samples:
            target.legendFormat === 'Execution cycle · {{outcome}}'
              ? [
                  { labels: '{outcome="succeeded"}', value: 1 },
                  { labels: '{outcome="failed"}', value: 2 },
                  { labels: '{outcome="interrupted"}', value: 3 },
                ]
              : [
                  { labels: '{outcome="succeeded"}', value: 4 },
                  { labels: '{outcome="failed"}', value: 5 },
                ],
        },
      ],
    })
  }
  runPromtool({ 'tests.yaml': YAML.stringify({ evaluation_interval: '1m', tests }) })
}, 30_000)
