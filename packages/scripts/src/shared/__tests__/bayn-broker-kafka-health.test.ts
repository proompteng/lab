import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../../', import.meta.url)
const script = fileURLToPath(new URL('argocd/applications/bayn/broker-kafka-health.sh', root))
const assigned = (count: string) => `# TYPE kafka_consumer_coordinator_assigned_partitions gauge
kafka_consumer_coordinator_assigned_partitions{client_id="consumer-proof",kafka_version="4.2.0"} ${count}\n`
const active = (count: string) => `# TYPE vertx_http_client_active_requests gauge
vertx_http_client_active_requests{method="POST"} ${count}\n`
const runProbe = async (metrics: string, status = 200) => {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname)
      return new Response(metrics, { status })
    },
  })
  try {
    const child = Bun.spawn(['bash', script], {
      env: { ...process.env, RESTATE_METRICS_PORT: String(server.port) },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    })
    return { code: await child.exited, stderr: await new Response(child.stderr).text(), paths }
  } finally {
    await server.stop(true)
  }
}

describe('Bayn broker Kafka ingestion health', () => {
  test.each(['1.0', '3.0'])('quiet assigned partitions retain a live ingestion stream each (%s)', async (count) => {
    const result = await runProbe(assigned(count) + active(count))
    expect(result).toEqual({ code: 0, stderr: '', paths: ['/metrics'] })
  })
  test('an idle group member with no assignment does not require a producer stream', async () => {
    expect((await runProbe(assigned('0.0'))).code).toBe(0)
  })
  test('a surviving TCP connection cannot hide a terminated assigned producer session', async () => {
    const metrics = assigned('1.0') + active('0.0') + 'vertx_http_client_active_connections 1.0\n'
    const result = await runProbe(metrics)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('assigned partitions lack active ingestion streams')
  })
  test('one remaining stream cannot hide a different stopped partition', async () => {
    expect((await runProbe(assigned('3.0') + active('2.0'))).code).toBe(1)
  })
  test.each([
    ['missing assignment', active('1.0')],
    ['missing stream', assigned('1.0')],
    ['negative terminal counter', assigned('1.0') + active('-1.0')],
    ['nonfinite assignment', assigned('NaN') + active('1.0')],
    ['fractional assignment', assigned('0.5') + active('1.0')],
    ['missing value', assigned('1.0').replace(' 1.0', '') + active('1.0')],
    ['broken assignment labels', assigned('1.0').replace('} 1.0', ' 1.0') + active('1.0')],
    ['broken stream labels', assigned('1.0') + active('1.0').replace('{method="POST"}', '{method="POST",broken')],
    ['duplicate series', assigned('1.0') + assigned('1.0') + active('2.0')],
    ['wrong metric type', assigned('1.0').replace(' gauge', ' counter') + active('1.0')],
    ['unrelated HTTP method', assigned('1.0') + active('1.0').replace('POST', 'GET')],
  ])('rejects %s', async (_name, metrics) => {
    expect((await runProbe(metrics)).code).toBe(1)
  })
  test('an HTTP failure cannot pass with an otherwise healthy-looking body', async () => {
    expect((await runProbe(assigned('1.0') + active('1.0'), 503)).code).toBe(1)
  })
  test('GitOps mounts the same read-only probe with a bounded process and reconnect grace', () => {
    const deployment = YAML.parse(
      readFileSync(new URL('argocd/applications/bayn/broker-kafka-ingress.yaml', root), 'utf8'),
    )
    const pod = deployment.spec.template.spec
    const container = pod.containers.find((entry: { name: string }) => entry.name === 'kafka-ingress')
    const command = ['/usr/bin/timeout', '2s', '/usr/bin/bash', '/opt/bayn/health/probe.sh']
    expect(container.readinessProbe).toMatchObject({ exec: { command }, periodSeconds: 5, timeoutSeconds: 3 })
    expect(container.livenessProbe).toMatchObject({
      exec: { command },
      periodSeconds: 10,
      failureThreshold: 6,
      timeoutSeconds: 3,
    })
    expect(container.volumeMounts).toContainEqual({ name: 'health', mountPath: '/opt/bayn/health', readOnly: true })
    expect(pod.volumes).toContainEqual({
      name: 'health',
      configMap: { name: 'bayn-broker-kafka-health', defaultMode: 0o444 },
    })
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532 })
    expect(container.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    })
    const kustomization = YAML.parse(readFileSync(new URL('argocd/applications/bayn/kustomization.yaml', root), 'utf8'))
    expect(kustomization.configMapGenerator).toContainEqual({
      name: 'bayn-broker-kafka-health',
      files: ['probe.sh=broker-kafka-health.sh'],
      options: { annotations: { 'argocd.argoproj.io/sync-wave': '-2' } },
    })
  })

  test('GitOps waits for registered Restate execution and its successful activation before broker ingress', () => {
    const manifest = (file: string) =>
      YAML.parse(readFileSync(new URL(`argocd/applications/bayn/${file}`, root), 'utf8'))
    const controller = manifest('execution-controller.yaml')
    const activation = manifest('execution-activation.yaml')
    const ingress = manifest('broker-kafka-ingress.yaml')
    expect(controller.kind).toBe('RestateDeployment')
    expect(activation.kind).toBe('Job')
    expect(activation.metadata.annotations['argocd.argoproj.io/hook']).toBe('Sync')
    expect(activation.metadata.annotations['argocd.argoproj.io/hook-delete-policy']).toContain('HookSucceeded')
    const wave = (resource: { metadata: { annotations: Record<string, string> } }) =>
      Number(resource.metadata.annotations['argocd.argoproj.io/sync-wave'])
    expect(wave(controller)).toBeLessThan(wave(activation))
    expect(wave(activation)).toBeLessThan(wave(ingress))
  })
})
