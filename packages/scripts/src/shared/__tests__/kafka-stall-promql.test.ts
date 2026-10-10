import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'

const property = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) throw new Error(`Missing rule object: ${key}`)
  return Reflect.get(value, key)
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Missing rule array')
  return value
}

test('Kafka telemetry alerts distinguish missing scrapes, JMX errors and follower gauges', () => {
  const manifest: unknown = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  )
  const text = property(property(manifest, 'data'), 'graf-rules.yaml')
  if (typeof text !== 'string') throw new Error('Missing Mimir rules')
  const expressions = new Map<string, string>()
  for (const group of array(property(YAML.parse(text), 'groups'))) {
    for (const rule of array(property(group, 'rules'))) {
      const name = property(rule, 'alert')
      const expr = property(rule, 'expr')
      if (typeof name === 'string' && typeof expr === 'string') expressions.set(name, expr)
    }
  }
  const pods = [
    'kafka-pool-a-0',
    'kafka-pool-a-1',
    'kafka-pool-a-2',
    'kafka-pool-b-3',
    'kafka-pool-b-4',
    'kafka-pool-b-5',
  ]
  const failed = pods[1]
  if (!failed) throw new Error('Missing fixture controller')
  const input = (
    options: {
      httpDown?: boolean
      jmxError?: boolean
      absent?: boolean
      controllerMissing?: boolean
      stopped?: boolean
    } = {},
  ) =>
    pods.flatMap((pod, index) => {
      const scope = `job="strimzi-kafka",namespace="kafka",cluster="kafka",pod="${pod}"`
      return [
        {
          series: `kube_pod_status_phase{namespace="kafka",phase="Running",pod="${pod}"}`,
          values: `${options.stopped && pod === failed ? 0 : 1}+0x10`,
        },
        ...(options.absent
          ? []
          : [
              { series: `up{${scope}}`, values: `${options.httpDown && pod === failed ? 0 : 1}+0x10` },
              { series: `jmx_scrape_error{${scope}}`, values: `${options.jmxError && pod === failed ? 1 : 0}+0x10` },
            ]),
        ...(index < 3 && !options.absent && !(options.controllerMissing && pod === failed)
          ? [{ series: `kafka_controller_activecontrollercount{${scope}}`, values: `${pod === failed ? 1 : 0}+0x10` }]
          : []),
      ]
    })
  const sample = (pod: string) => ({
    labels: `{__name__="kube_pod_status_phase",namespace="kafka",phase="Running",pod="${pod}"}`,
    value: 1,
  })
  const cases = [
    { name: 'healthy exporters and inactive follower gauges', options: {}, scrape: [], controller: [] },
    { name: 'one failed HTTP target', options: { httpDown: true }, scrape: [failed], controller: [] },
    { name: 'HTTP succeeds but JMX collection fails', options: { jmxError: true }, scrape: [failed], controller: [] },
    { name: 'all exporter series absent', options: { absent: true }, scrape: pods, controller: pods.slice(0, 3) },
    {
      name: 'successful exporter with missing controller mapping',
      options: { controllerMissing: true },
      scrape: [],
      controller: [failed],
    },
    {
      name: 'stopped pod without metrics is not a running target',
      options: { absent: true, stopped: true },
      scrape: pods.filter((pod) => pod !== failed),
      controller: pods.slice(0, 3).filter((pod) => pod !== failed),
    },
  ].map(({ name, options, scrape, controller }) => ({
    name,
    interval: '1m',
    input_series: input(options),
    promql_expr_test: [
      { name: 'KafkaMetricsUnavailable', expected: scrape },
      { name: 'KafkaControllerTelemetryMissing', expected: controller },
    ].map(({ name, expected }) => {
      const expr = expressions.get(name)
      if (!expr) throw new Error(`Missing alert: ${name}`)
      return { expr, eval_time: '10m', exp_samples: expected.map(sample) }
    }),
  }))
  const directory = mkdtempSync(join(tmpdir(), 'kafka-stall-promql-'))
  try {
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: [], evaluation_interval: '1m', tests: cases }),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0)
      throw new Error(`PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
