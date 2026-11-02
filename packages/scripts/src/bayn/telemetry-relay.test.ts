import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../', import.meta.url)
const text = (path: string) => readFileSync(new URL(`argocd/applications/bayn/${path}`, root), 'utf8')
const objects = YAML.parseAllDocuments(text('telemetry.yaml')).map((document) => document.toJSON())

test('the bounded trace relay precedes its clients and holds no broker identity or credentials', () => {
  const deployment = objects.find((object) => object.kind === 'Deployment')
  expect(deployment.spec.replicas).toBe(2)
  expect(deployment.spec.strategy.rollingUpdate.maxUnavailable).toBe(0)
  const pod = deployment.spec.template.spec
  expect(pod.automountServiceAccountToken).toBe(false)
  expect(pod.volumes.every((volume: Record<string, unknown>) => volume.secret === undefined)).toBe(true)
  expect(pod.containers[0].image).toContain('@sha256:')
  expect(pod.containers[0].resources.limits.memory).toBe('512Mi')
  expect(
    pod.containers[0].env.find((entry: { name: string }) => entry.name === 'HOSTNAME').valueFrom.fieldRef.fieldPath,
  ).toBe('metadata.name')
  const receiver = objects.find(
    (object) => object.kind === 'NetworkPolicy' && object.metadata.name === 'bayn-telemetry',
  )
  const clients = objects.find(
    (object) => object.kind === 'NetworkPolicy' && object.metadata.name === 'bayn-telemetry-clients',
  )
  for (const name of ['deployment', 'execution-controller', 'execution-activation', 'research-worker']) {
    const workload = YAML.parse(text(`${name}.yaml`))
    const template = workload.spec.template
    const label = template.metadata.labels['app.kubernetes.io/name']
    expect(receiver.spec.ingress[0].from[0].podSelector.matchExpressions[0].values).toContain(label)
    expect(clients.spec.podSelector.matchExpressions[0].values).toContain(label)
    expect(Number(deployment.metadata.annotations['argocd.argoproj.io/sync-wave'])).toBeLessThan(
      Number(workload.metadata.annotations?.['argocd.argoproj.io/sync-wave'] ?? 0),
    )
    expect(
      template.spec.containers[0].env.find(
        (entry: { name: string }) => entry.name === 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      ).value,
    ).toBe('http://bayn-telemetry.bayn.svc.cluster.local:4318/v1/traces')
  }
  const kustomization = YAML.parse(text('kustomization.yaml'))
  expect(kustomization.resources).toContain('telemetry.yaml')
  expect(
    kustomization.configMapGenerator.find((entry: { name: string }) => entry.name === 'bayn-telemetry').files,
  ).toContain('config.alloy=telemetry.alloy')
  const config = text('telemetry.alloy')
  expect(config).toContain('sizer            = "bytes"')
  expect(config).toContain('queue_size       = 16777216')
  expect(config).toContain('max_elapsed_time = "120s"')
  expect(config).toContain('otelcol.processor.memory_limiter')
  expect(config).not.toContain('otelcol.exporter.debug')
})
