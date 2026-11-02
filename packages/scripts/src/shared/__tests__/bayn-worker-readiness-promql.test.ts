import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'

interface Rule {
  readonly alert?: string
  readonly record?: string
  readonly expr: string
  readonly labels?: Record<string, string>
  readonly annotations?: Record<string, string>
}

const identity =
  'job="kube-state-metrics",instance="collector",namespace="bayn",restate_deployment="bayn-execution-controller"'
const metrics = {
  desired: 'kube_restate_deployment_spec_replicas',
  ready: 'kube_restate_deployment_status_ready_replicas',
  generation: 'kube_restate_deployment_metadata_generation',
  observed: 'kube_restate_deployment_status_observed_generation',
} as const
const defaults = { desired: '2+0x40', ready: '2+0x40', generation: '719+0x40', observed: '719+0x40' }
type Values = Partial<Record<keyof typeof metrics, string | null>>
const series = (overrides: Values = {}, up: string | null = '1+0x40', labels = identity) => [
  ...Object.entries(metrics).flatMap(([key, metric]) => {
    const value = { ...defaults, ...overrides }[key as keyof typeof metrics]
    return value === null ? [] : [{ series: `${metric}{${labels}}`, values: value }]
  }),
  ...(up === null
    ? []
    : [
        {
          series: `up{${labels
            .split(',')
            .filter((label) => /^(job|instance)=/.test(label))
            .join(',')}}`,
          values: up,
        },
      ]),
]

test('retained workers cannot satisfy current execution-worker readiness or failover capacity', () => {
  const manifest = YAML.parse(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  )
  const groups = YAML.parse(manifest.data['graf-rules.yaml']) as { groups: { name: string; rules: Rule[] }[] }
  const group = groups.groups.find(({ name }) => name === 'bayn-cycle-operations.rules')
  if (group === undefined) throw new Error('Missing Bayn rules')
  const unavailable = 'BaynExecutionWorkerUnavailable'
  const underReplicated = 'BaynExecutionWorkerReplicaTargetMissed'
  const unknown = 'BaynExecutionWorkerObservationUnavailable'
  const names = [unavailable, underReplicated, unknown]
  const selected = group.rules.filter(
    ({ alert, record }) => record?.startsWith('bayn:execution_worker_') || names.includes(alert ?? ''),
  )
  const alert = (name: string) => {
    const rule = selected.find(({ alert }) => alert === name)
    if (rule === undefined) throw new Error(`Missing ${name}`)
    return {
      exp_labels: { namespace: 'bayn', restate_deployment: 'bayn-execution-controller', ...rule.labels },
      exp_annotations: rule.annotations,
    }
  }
  const cases: { name: string; values: ReturnType<typeof series>; fires: string[]; at?: string; ready?: number }[] = [
    {
      name: 'retained two cannot mask zero current workers',
      values: series({ ready: '0+0x40' }),
      fires: [unavailable, underReplicated],
      ready: 0,
    },
    {
      name: 'retained two cannot supply missing current failover replica',
      values: series({ ready: '1+0x40' }),
      fires: [underReplicated],
      ready: 1,
    },
    { name: 'current pair is healthy independently of retained workers', values: series(), fires: [], ready: 2 },
    {
      name: 'one desired worker does not require failover capacity',
      values: series({ desired: '1+0x40', ready: '1+0x40' }),
      fires: [],
      ready: 1,
    },
    {
      name: 'zero of one desired worker is unavailable only',
      values: series({ desired: '1+0x40', ready: '0+0x40' }),
      fires: [unavailable],
      ready: 0,
    },
    {
      name: 'intentional scale to zero is not an outage',
      values: series({ desired: '0+0x40', ready: '0+0x40' }),
      fires: [],
      ready: 0,
    },
    ...Object.keys(metrics).map((key) => ({
      name: `missing ${key} is unknown, not measured zero`,
      values: series({ [key]: null }),
      fires: [unknown],
    })),
    ...Object.keys(metrics).map((key) => ({
      name: `stale ${key} cannot remain healthy`,
      values: series({ [key]: `${key === 'observed' || key === 'generation' ? 719 : 2} _x40` }),
      at: '4m',
      fires: [unknown],
    })),
    { name: 'missing entire CR preserves the expected target', values: [], fires: [unknown] },
    { name: 'failed scrape is unknown', values: series({}, '0+0x40'), fires: [unknown] },
    { name: 'missing scrape health is unknown', values: series({}, null), fires: [unknown] },
    { name: 'stale scrape health is unknown', values: series({}, '1 _x40'), at: '4m', fires: [unknown] },
    { name: 'unobserved current generation is unknown', values: series({ generation: '720+0x40' }), fires: [unknown] },
    {
      name: 'foreign namespace cannot satisfy Bayn readiness',
      values: series({}, '1+0x40', identity.replace('namespace="bayn"', 'namespace="other"')),
      fires: [unknown],
    },
    {
      name: 'foreign resource cannot satisfy Bayn readiness',
      values: series(
        {},
        '1+0x40',
        identity.replace('restate_deployment="bayn-execution-controller"', 'restate_deployment="other"'),
      ),
      fires: [unknown],
    },
    {
      name: 'foreign job cannot satisfy Bayn readiness',
      values: series({}, '1+0x40', identity.replace('job="kube-state-metrics"', 'job="other"')),
      fires: [unknown],
    },
    {
      name: 'duplicate collectors do not add readiness',
      values: [
        ...series({ ready: '1+0x40' }),
        ...series({ ready: '1+0x40' }, '1+0x40', identity.replace('collector', 'second')),
      ],
      fires: [underReplicated],
      ready: 1,
    },
    {
      name: 'a duplicate healthy sample cannot mask a reported zero',
      values: [...series(), ...series({ ready: '0+0x40' }, '1+0x40', identity.replace('collector', 'second'))],
      fires: [unavailable, underReplicated],
      ready: 0,
    },
    {
      name: 'a lagging collector cannot certify an older generation',
      values: [...series(), ...series({ generation: '720+0x40' }, '1+0x40', identity.replace('collector', 'second'))],
      fires: [unknown],
    },
    {
      name: 'stale duplicate desired count cannot cause a false capacity warning',
      values: [...series(), ...series({ desired: '3 _x40' }, '1+0x40', identity.replace('collector', 'second'))],
      at: '4m',
      fires: [],
      ready: 2,
    },
    {
      name: 'zero current count is pending before one minute',
      values: series({ ready: '0+0x40' }),
      at: '45s',
      fires: [],
      ready: 0,
    },
    {
      name: 'zero current count fires at one minute',
      values: series({ ready: '0+0x40' }),
      at: '1m',
      fires: [unavailable],
      ready: 0,
    },
    {
      name: 'capacity warning is pending before two minutes',
      values: series({ ready: '1+0x40' }),
      at: '1m45s',
      fires: [],
      ready: 1,
    },
    {
      name: 'capacity warning fires at two minutes',
      values: series({ ready: '1+0x40' }),
      at: '2m',
      fires: [underReplicated],
      ready: 1,
    },
    {
      name: 'generation lag is pending before two minutes',
      values: series({ generation: '720+0x40' }),
      at: '1m45s',
      fires: [],
    },
    {
      name: 'generation lag cannot suppress warning indefinitely',
      values: series({ generation: '720+0x40' }),
      at: '2m',
      fires: [unknown],
    },
    {
      name: 'brief generation lag during rollout recovers without a warning',
      values: series({ generation: '720+0x40', observed: '719+0x3 720+0x36' }),
      fires: [],
      ready: 2,
    },
    {
      name: 'brief zero readiness during rollout recovers within the grace',
      values: series({ ready: '0+0x3 2+0x36' }),
      fires: [],
      ready: 2,
    },
    {
      name: 'measured readiness recovery clears both capacity alerts',
      values: series({ ready: '0+0x8 2+0x32' }),
      at: '2m15s',
      fires: [],
      ready: 2,
    },
    {
      name: 'loss of a zero sample becomes unknown rather than healthy',
      values: series({ ready: '0+0x4 stale' }),
      at: '4m',
      fires: [unknown],
    },
    {
      name: 'lost zero observation immediately becomes pending unknown, not known healthy',
      values: series({ ready: '0+0x4 stale' }),
      at: '1m30s',
      fires: [],
    },
    { name: 'invalid negative current count is unknown', values: series({ ready: '-1+0x40' }), fires: [unknown] },
    { name: 'invalid negative desired count is unknown', values: series({ desired: '-1+0x40' }), fires: [unknown] },
  ]
  const evaluations = cases.map(({ name, values, fires, at = '3m', ready }) => ({
    name,
    interval: '15s',
    input_series: [
      ...values,
      {
        series:
          'kube_replicaset_status_ready_replicas{namespace="bayn",replicaset="bayn-execution-controller-retained"}',
        values: '2+0x40',
      },
    ],
    alert_rule_test: names.map((alertname) => ({
      alertname,
      eval_time: at,
      exp_alerts: fires.includes(alertname) ? [alert(alertname)] : [],
    })),
    promql_expr_test: [
      {
        expr: `ALERTS{alertname="${unknown}"}`,
        eval_time: at,
        exp_samples:
          ready !== undefined
            ? []
            : [
                {
                  labels: `ALERTS{${Object.entries({
                    alertname: unknown,
                    alertstate: fires.includes(unknown) ? 'firing' : 'pending',
                    ...alert(unknown).exp_labels,
                  })
                    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                    .join(',')}}`,
                  value: 1,
                },
              ],
      },
      {
        expr: 'bayn:execution_worker_observed_ready_replicas',
        eval_time: at,
        exp_samples:
          ready === undefined
            ? []
            : [
                {
                  labels:
                    'bayn:execution_worker_observed_ready_replicas{namespace="bayn",restate_deployment="bayn-execution-controller"}',
                  value: ready,
                },
              ],
      },
    ],
  }))
  const directory = mkdtempSync(join(tmpdir(), 'bayn-worker-readiness-'))
  try {
    writeFileSync(
      join(directory, 'rules.yaml'),
      YAML.stringify({ groups: [{ name: group.name, interval: '15s', rules: selected }] }),
    )
    writeFileSync(
      join(directory, 'tests.yaml'),
      YAML.stringify({ rule_files: ['rules.yaml'], evaluation_interval: '15s', tests: evaluations }),
    )
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
}, 30_000)
