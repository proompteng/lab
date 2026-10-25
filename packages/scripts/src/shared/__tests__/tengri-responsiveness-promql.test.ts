import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const alertNames = [
  'CephOsdReadLatencyHigh',
  'CephOsdQueueWaitHigh',
  'TengriTerminalHeartbeatLatencyHigh',
  'TengriGuestConnectLatencyHigh',
]

const stringMap = (value: unknown): Record<string, string> => {
  if (!YAML.isMap(value)) throw new Error('Alert metadata must be a map')
  return Object.fromEntries(
    value.items.map(({ key, value: item }) => {
      if (
        !YAML.isScalar(key) ||
        typeof key.value !== 'string' ||
        !YAML.isScalar(item) ||
        typeof item.value !== 'string'
      ) {
        throw new Error('Alert metadata must contain strings')
      }
      return [key.value, item.value]
    }),
  )
}

test('responsiveness rules fire, recover, retain OSD identity, and reject idle or sparse histograms', () => {
  const manifest = YAML.parseDocument(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  )
  const contents = manifest.getIn(['data', 'graf-rules.yaml'])
  if (typeof contents !== 'string') throw new Error('Mimir rules are missing')
  const groups = YAML.parseDocument(contents).get('groups')
  if (!YAML.isSeq(groups)) throw new Error('Mimir groups are missing')
  const alerts = groups.items.filter(YAML.isMap).flatMap((group) => {
    const rules = group.get('rules')
    if (!YAML.isSeq(rules)) throw new Error('Mimir rules are missing')
    return rules.items.filter(YAML.isMap).flatMap((rule) => {
      const alert = rule.get('alert')
      if (typeof alert !== 'string' || !alertNames.includes(alert)) return []
      const expr = rule.get('expr')
      const duration = rule.get('for')
      if (typeof expr !== 'string' || typeof duration !== 'string')
        throw new Error('Alert expression or duration is missing')
      return [
        {
          alert,
          expr,
          for: duration,
          labels: stringMap(rule.get('labels')),
          annotations: stringMap(rule.get('annotations')),
        },
      ]
    })
  })
  expect(alerts.map(({ alert }) => alert).sort()).toEqual([...alertNames].sort())

  const scenarios = [
    { name: 'healthy active traffic', slow: false, step: 10, recovered: false, namespace: 'tengri', firing: [] },
    { name: 'sustained latency', slow: true, step: 10, recovered: false, namespace: 'tengri', firing: alertNames },
    {
      name: 'sparse terminal observations',
      slow: true,
      step: 0.1,
      recovered: false,
      namespace: 'tengri',
      firing: alertNames.slice(0, 2),
    },
    {
      name: 'recovery after sustained latency',
      slow: true,
      step: 10,
      recovered: true,
      namespace: 'tengri',
      firing: alertNames,
    },
    {
      name: 'exact Ceph thresholds',
      slow: false,
      step: 10,
      recovered: false,
      namespace: 'tengri',
      firing: [],
      read: 0.5,
      queue: 0.1,
    },
    {
      name: 'unrelated terminal namespace',
      slow: true,
      step: 10,
      recovered: false,
      namespace: 'other',
      firing: alertNames.slice(0, 2),
    },
  ]
  const cases = scenarios.map((scenario) => {
    const values = (at: (index: number) => number) => Array.from({ length: 91 }, (_, index) => at(index)).join(' ')
    const counters = (name: string) => {
      const labels = `job="tengri",namespace="${scenario.namespace}"`
      return [
        ...['0.05', '0.1', '0.25', '0.3', '0.5', '+Inf'].map((bound) => ({
          series: `${name}_bucket{${labels},le="${bound}"}`,
          values: values((index) => {
            const count = index * scenario.step
            if (Number(bound) >= 0.5 || bound === '+Inf' || !scenario.slow) return count
            return scenario.recovered ? Math.max(0, index - 30) * scenario.step : 0
          }),
        })),
        { series: `${name}_count{${labels}}`, values: values((index) => index * scenario.step) },
      ]
    }
    const input_series = [
      {
        series: 'ceph_storage:osd_read_latency_seconds:mean5m{node="turin",ceph_daemon="osd.1"}',
        values: values((index) =>
          scenario.recovered && index >= 30 ? 0.01 : (scenario.read ?? (scenario.slow ? 0.6 : 0.01)),
        ),
      },
      {
        series: 'ceph_storage:osd_queue_wait_seconds:estimated_mean5m{node="turin",ceph_daemon="osd.1"}',
        values: values((index) =>
          scenario.recovered && index >= 30 ? 0.01 : (scenario.queue ?? (scenario.slow ? 0.2 : 0.01)),
        ),
      },
      ...counters('tengri_terminal_heartbeat_seconds'),
      ...counters('tengri_guest_connect_seconds'),
    ]
    return {
      name: scenario.name,
      interval: '30s',
      input_series,
      alert_rule_test: alerts.flatMap((rule) =>
        ['4m30s', '12m', '44m'].map((eval_time) => {
          const firing =
            eval_time !== '4m30s' &&
            !(scenario.recovered && eval_time === '44m') &&
            scenario.firing.includes(rule.alert)
          const ceph = rule.alert.startsWith('Ceph')
          const annotations = Object.fromEntries(
            Object.entries(rule.annotations).map(([key, value]) => [
              key,
              value.replaceAll('{{ $labels.node }}', 'turin').replaceAll('{{ $labels.ceph_daemon }}', 'osd.1'),
            ]),
          )
          return {
            alertname: rule.alert,
            eval_time,
            exp_alerts: firing
              ? [
                  {
                    exp_labels: { ...rule.labels, ...(ceph ? { node: 'turin', ceph_daemon: 'osd.1' } : {}) },
                    exp_annotations: annotations,
                  },
                ]
              : [],
          }
        }),
      ),
    }
  })
  cases.push({
    name: 'missing observations remain unknown',
    interval: '30s',
    input_series: [],
    alert_rule_test: alerts.map(({ alert }) => ({ alertname: alert, eval_time: '44m', exp_alerts: [] })),
  })
  const directory = mkdtempSync(join(tmpdir(), 'tengri-responsiveness-promql-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: 'responsiveness', rules: alerts }] }),
    )
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: ['rules.yaml'], evaluation_interval: '30s', tests: cases }),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0)
      throw new Error(`Real PromQL evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
