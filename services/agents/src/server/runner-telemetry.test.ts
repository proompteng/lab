import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRunnerTelemetry, createTelemetryPublisher } from '../runner/telemetry'
import { withRunnerTelemetry } from './runner-telemetry'

const objects = new Map<string, string>()
const requests: Array<{ method: string | undefined; path: string }> = []
const server = createServer(async (request, response) => {
  const path = request.url ?? ''
  requests.push({ method: request.method, path })
  if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=test-access/')) {
    response.writeHead(403).end()
    return
  }
  if (request.method === 'PUT') {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    objects.set(path, Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200).end()
    return
  }
  const value = objects.get(path)
  response.writeHead(value === undefined ? 404 : 200).end(value)
})
let endpoint = ''
beforeAll(async () => {
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  endpoint = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

describe('run-authorized progress transport', () => {
  it('publishes and reads the exact UID key using existing artifact credentials', async () => {
    const env = { AGENTS_ARTIFACTS_ENDPOINT: endpoint, AGENTS_ARTIFACTS_BUCKET: 'agents-artifacts' }
    const publish = createTelemetryPublisher({
      ...env,
      AGENT_RUN_NAMESPACE: 'agents',
      AGENT_RUN_UID: 'run-uid',
      AWS_ACCESS_KEY_ID: 'test-access',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
    })
    const telemetry = createRunnerTelemetry({ podName: 'worker', write: () => {} }).snapshot()
    await publish?.(telemetry)
    const kube = {
      get: vi.fn(async () => ({
        data: {
          AWS_ACCESS_KEY_ID: Buffer.from('test-access').toString('base64'),
          AWS_SECRET_ACCESS_KEY: Buffer.from('test-secret').toString('base64'),
        },
      })),
    }
    const resource = {
      metadata: { uid: 'run-uid' },
      spec: { runtime: { type: 'job' }, secrets: ['agents-artifacts'] },
      status: { phase: 'Running' },
    }
    expect(await withRunnerTelemetry(kube, resource, 'agents', { env })).toMatchObject({
      status: { runner: { telemetry } },
    })
    expect(requests.slice(-2)).toEqual([
      { method: 'PUT', path: '/agents-artifacts/runner-telemetry/agents/run-uid.json' },
      { method: 'GET', path: '/agents-artifacts/runner-telemetry/agents/run-uid.json' },
    ])
    expect(kube.get).toHaveBeenCalledWith('secret', 'agents-artifacts', 'agents')
    const other = { ...resource, metadata: { uid: 'other-run' } }
    expect(await withRunnerTelemetry(kube, other, 'agents', { env })).toBe(other)
    expect(requests.at(-1)?.path).toBe('/agents-artifacts/runner-telemetry/agents/other-run.json')
  })

  it('does not read credentials or storage when the run has not authorized artifact storage', async () => {
    const kube = { get: vi.fn(async () => null) }
    const resource = { metadata: { uid: 'run-uid' }, spec: { runtime: { type: 'job' }, secrets: ['codex-auth'] } }
    const before = requests.length
    expect(
      await withRunnerTelemetry(kube, resource, 'agents', {
        env: { AGENTS_ARTIFACTS_ENDPOINT: endpoint, AGENTS_ARTIFACTS_BUCKET: 'agents-artifacts' },
      }),
    ).toBe(resource)
    expect(kube.get).not.toHaveBeenCalled()
    expect(requests).toHaveLength(before)
  })

  it.each([{}, { AGENTS_ARTIFACTS_ENDPOINT: 'http://storage.test' }])(
    'keeps run reads available without complete control-plane storage configuration: %j',
    async (env) => {
      const kube = {
        get: vi.fn(async () => ({
          data: {
            AWS_ACCESS_KEY_ID: Buffer.from('test-access').toString('base64'),
            AWS_SECRET_ACCESS_KEY: Buffer.from('test-secret').toString('base64'),
          },
        })),
      }
      const resource = {
        metadata: { uid: 'run-uid' },
        spec: { runtime: { type: 'job' }, secrets: ['agents-artifacts'] },
      }
      const before = requests.length
      expect(await withRunnerTelemetry(kube, resource, 'agents', { env })).toBe(resource)
      expect(kube.get).not.toHaveBeenCalled()
      expect(requests).toHaveLength(before)
    },
  )
})
