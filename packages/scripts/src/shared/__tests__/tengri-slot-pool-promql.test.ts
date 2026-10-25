import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

test('Tengri slot alerts detect missing and unready Pods without paging for a healthy occupied pool', () => {
  const manifest = YAML.parseDocument(
    readFileSync(
      new URL('../../../../../argocd/applications/observability/graf-mimir-rules.yaml', import.meta.url),
      'utf8',
    ),
  )
  const contents = manifest.getIn(['data', 'graf-rules.yaml'])
  if (typeof contents !== 'string') throw new Error('Mimir rules are missing')
  const groups = YAML.parseDocument(contents).get('groups')
  if (!YAML.isSeq(groups)) throw new Error('Mimir rule groups are missing')
  const group = groups.items.find((node) => YAML.isMap(node) && node.get('name') === 'tengri-production.rules')
  if (!YAML.isMap(group)) throw new Error('Tengri rule group is missing')
  const rules = group.get('rules')
  if (!YAML.isSeq(rules)) throw new Error('Tengri rules are missing')
  const names = ['TengriSlotPodsMissing', 'TengriSlotPoolUnavailable']
  const alerts = rules.items.filter(YAML.isMap).filter((rule) => names.includes(String(rule.get('alert'))))
  expect(alerts).toHaveLength(2)

  const scenarios = [
    { name: 'healthy occupied pool', pods: 6, ready: '1+0x20', deployed: true, copies: 1, firing: [] },
    { name: 'one missing slot', pods: 5, ready: '1+0x20', deployed: true, copies: 1, firing: names.slice(0, 1) },
    { name: 'all slot Pods lost', pods: 0, ready: '1+0x20', deployed: true, copies: 1, firing: names },
    { name: 'all slots unready', pods: 6, ready: '0+0x20', deployed: true, copies: 1, firing: names.slice(1) },
    { name: 'before first deployment', pods: 0, ready: '0+0x20', deployed: false, copies: 1, firing: [] },
    { name: 'brief preparation', pods: 6, ready: '0 0 0 0 1+0x16', deployed: true, copies: 1, firing: [] },
    {
      name: 'duplicate scrapes cannot hide missing slots',
      pods: 3,
      ready: '1+0x20',
      deployed: true,
      copies: 2,
      firing: names.slice(0, 1),
    },
  ]
  const cases = scenarios.map((scenario) => ({
    name: scenario.name,
    interval: '30s',
    input_series: [
      ...(scenario.deployed
        ? [
            {
              series: 'kube_argocd_application_deployment_history_info{namespace="argocd",application="tengri"}',
              values: '1+0x20',
            },
          ]
        : []),
      { series: 'kube_pod_info{namespace="other",pod="tengri-slot-unrelated"}', values: '1+0x20' },
      {
        series: 'kube_pod_status_ready{namespace="other",pod="tengri-slot-unrelated",condition="true"}',
        values: '1+0x20',
      },
      ...Array.from({ length: scenario.pods }, (_, pod) =>
        Array.from({ length: scenario.copies }, (_, copy) => [
          { series: `kube_pod_info{namespace="tengri",pod="tengri-slot-${pod}",instance="${copy}"}`, values: '1+0x20' },
          {
            series: `kube_pod_status_ready{namespace="tengri",pod="tengri-slot-${pod}",instance="${copy}",condition="true"}`,
            values: scenario.ready,
          },
          {
            series: `kube_pod_status_ready{namespace="tengri",pod="tengri-slot-${pod}",instance="${copy}",condition="false"}`,
            values: '1+0x20',
          },
        ]),
      ).flat(2),
    ],
    alert_rule_test: alerts.flatMap((rule) => {
      const alert = String(rule.get('alert'))
      const labels = rule.get('labels')
      const annotations = rule.get('annotations')
      if (!YAML.isMap(labels) || !YAML.isMap(annotations)) throw new Error('Alert metadata is missing')
      return [
        { alertname: alert, eval_time: '4m30s', exp_alerts: [] },
        {
          alertname: alert,
          eval_time: '10m',
          exp_alerts: scenario.firing.includes(alert)
            ? [{ exp_labels: labels.toJSON(), exp_annotations: annotations.toJSON() }]
            : [],
        },
      ]
    }),
  }))
  const directory = mkdtempSync(join(tmpdir(), 'tengri-slot-promql-'))
  try {
    writeFileSync(join(directory, 'rules.yaml'), YAML.stringify({ groups: [group.toJSON()] }))
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
})
