import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const read = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8')
interface Resource {
  readonly groupVersionKind: { readonly group: string; readonly version: string; readonly kind: string }
  readonly metricNamePrefix: string
  readonly labelsFromPath: Record<string, readonly string[]>
  readonly metrics: readonly {
    readonly name: string
    readonly each: {
      readonly type: string
      readonly gauge: { readonly path: readonly string[]; readonly nilIsZero?: boolean }
    }
  }[]
}
const values = YAML.parse(read('argocd/applications/observability/kube-state-metrics-values.yaml')) as {
  customResourceState: { enabled: boolean; config: { spec: { resources: Resource[] } } }
  rbac: { extraRules: { apiGroups: string[]; resources: string[]; verbs: string[] }[] }
}
const resource = values.customResourceState.config.spec.resources.find(
  ({ groupVersionKind }) => groupVersionKind.group === 'restate.dev' && groupVersionKind.kind === 'RestateDeployment',
)
if (resource === undefined) throw new Error('RestateDeployment metric configuration is missing')

test('current-revision metrics use the installed CRD scalar fields and preserve resource identity', () => {
  expect(values.customResourceState.enabled).toBe(true)
  expect(resource.groupVersionKind.version).toBe('v1beta1')
  expect(resource.metricNamePrefix).toBe('kube_restate')
  expect(resource.labelsFromPath).toEqual({
    namespace: ['metadata', 'namespace'],
    restate_deployment: ['metadata', 'name'],
  })
  expect(resource.metrics.map(({ name }) => name)).toEqual([
    'deployment_spec_replicas',
    'deployment_status_ready_replicas',
    'deployment_metadata_generation',
    'deployment_status_observed_generation',
  ])
  for (const [name, path] of [
    ['deployment_status_ready_replicas', ['status', 'readyReplicas']],
    ['deployment_metadata_generation', ['metadata', 'generation']],
    ['deployment_status_observed_generation', ['status', 'observedGeneration']],
  ] as const) {
    // Missing/null status must remain unknown, not become a fabricated zero count.
    expect(resource.metrics.find((metric) => metric.name === name)?.each).toEqual({
      type: 'Gauge',
      gauge: { path, nilIsZero: false },
    })
  }
  expect(values.rbac.extraRules.find(({ apiGroups }) => apiGroups.includes('restate.dev'))).toEqual({
    apiGroups: ['restate.dev'],
    resources: ['restatedeployments'],
    verbs: ['list', 'watch'],
  })
})

test('Alloy forwards the emitted gauge names without widening the metrics allowlist', () => {
  const alloy = read('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const block = /prometheus\.relabel "arc_resource_metrics" \{([\s\S]*?)\n\}/.exec(alloy)?.[1]
  const regex = /regex\s*=\s*"([^"]+)"/.exec(block ?? '')?.[1]
  if (regex === undefined) throw new Error('Cluster metric keep rule is missing')
  const keep = new RegExp(`^(?:${regex})$`)
  for (const metric of resource.metrics) {
    const emittedName = `${resource.metricNamePrefix}_${metric.name}`
    expect(keep.test(`${emittedName};bayn;`)).toBe(true)
    expect(keep.test(`${emittedName}_unrecognized;bayn;`)).toBe(false)
  }
  expect(keep.test('kube_restate_unrelated;bayn;')).toBe(false)
  const deployment = YAML.parse(read('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml'))
  expect(deployment.spec.template.metadata.annotations['observability.proompteng.ai/config-sha256']).toBe(
    createHash('sha256').update(alloy).digest('hex'),
  )
})
