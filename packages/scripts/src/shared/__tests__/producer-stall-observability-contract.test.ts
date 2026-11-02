import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('retains producer CFS diagnostics without expanding other resource metric families', () => {
  const source = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const policy = /prometheus\.relabel "arc_resource_metrics" \{(.*?)\n\}/s.exec(source)?.[1]
  if (policy === undefined) throw new Error('Resource metric retention policy is missing')
  const expression = /regex\s*=\s*"([^"]+)"/.exec(policy)?.[1]
  if (expression === undefined) throw new Error('Resource metric retention expression is missing')
  expect(policy).toContain('source_labels = ["__name__", "namespace", "container"]')
  const retained = new RegExp(`^(?:${expression})$`)

  for (const name of [
    'container_cpu_cfs_periods_total',
    'container_cpu_cfs_throttled_periods_total',
    'container_cpu_cfs_throttled_seconds_total',
  ]) {
    expect(retained.test(`${name};torghut;torghut-ws`)).toBe(true)
    expect(retained.test(`${name};bayn;execution-controller`)).toBe(true)
    expect(retained.test(`${name};bayn;postgres`)).toBe(true)
    expect(retained.test(`${name};torghut;torghut-ws-options`)).toBe(false)
    expect(retained.test(`${name};torghut;alloy`)).toBe(false)
    expect(retained.test(`${name};other;torghut-ws`)).toBe(false)
    expect(retained.test(`${name};torghut;`)).toBe(false)
  }
  for (const name of [
    'up',
    'container_cpu_usage_seconds_total',
    'container_memory_working_set_bytes',
    'kube_pod_container_resource_limits',
    'kube_deployment_status_replicas_available',
  ]) {
    expect(retained.test(`${name};torghut;torghut-ws`)).toBe(true)
    expect(retained.test(`${name};;`)).toBe(true)
    expect(retained.test(`${name};other;unrelated`)).toBe(true)
  }
  expect(retained.test('container_cpu_cfs_unknown_total;torghut;torghut-ws')).toBe(false)
  expect(retained.test('future_unbounded_metric;bayn;execution-controller')).toBe(false)

  const deployment = YAML.parse(
    readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml'),
  ) as { spec: { template: { metadata: { annotations: Record<string, string> } } } }
  expect(deployment.spec.template.metadata.annotations['observability.proompteng.ai/config-sha256']).toBe(
    createHash('sha256').update(source).digest('hex'),
  )
})
