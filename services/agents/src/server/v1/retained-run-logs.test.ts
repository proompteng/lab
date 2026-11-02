import { createHash, createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '../kube-types'

import { getAgentRunLogsHandler } from './agent-run-logs'

const requests: Array<{ path: string | undefined; authorization: string | undefined; range: string | undefined }> = []
let oversized = false
const server = createServer((request, response) => {
  requests.push({ path: request.url, authorization: request.headers.authorization, range: request.headers.range })
  const date = String(request.headers['x-amz-date'])
  const payloadHash = String(request.headers['x-amz-content-sha256'])
  const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [
    request.method,
    request.url,
    '',
    `host:${request.headers.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest()
  const signingKey = hmac(hmac(hmac(hmac('AWS4test-secret', date.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request')
  const toSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex')
  if (
    request.headers.authorization !==
    `AWS4-HMAC-SHA256 Credential=test-access/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  ) {
    response.writeHead(403)
    response.end('SignatureDoesNotMatch')
    return
  }
  if (oversized) {
    response.writeHead(200)
    response.end('x'.repeat(524289))
    return
  }
  response.writeHead(206, { 'content-range': 'bytes 100-199/200' })
  response.end('partial-record\n{"event":"first"}\n{"event":"last"}\n')
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

const fixture = () => {
  oversized = false
  requests.length = 0
  const kube: KubernetesClient = {
    apply: vi.fn(async () => ({})),
    applyManifest: vi.fn(async () => ({})),
    applyStatus: vi.fn(async () => ({})),
    createManifest: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    get: vi.fn(async () => ({
      data: {
        AWS_ACCESS_KEY_ID: Buffer.from('test-access').toString('base64'),
        AWS_SECRET_ACCESS_KEY: Buffer.from('test-secret').toString('base64'),
      },
    })),
    list: vi.fn(async () => ({ items: [] })),
    listEvents: vi.fn(async () => ({ items: [] })),
    logs: vi.fn(async () => ''),
  }
  const close = vi.fn(async () => {})
  const deps = {
    kubeClient: kube,
    env: { AGENTS_ARTIFACTS_ENDPOINT: endpoint, AGENTS_ARTIFACTS_BUCKET: 'agents-artifacts' },
    storeFactory: () => ({
      ready: Promise.resolve(),
      close,
      getAgentRunByExternalRunId: async () => ({
        id: 'record',
        agentName: 'agent',
        deliveryId: 'delivery',
        provider: 'job',
        status: 'Succeeded',
        externalRunId: 'run-1',
        payload: {
          request: { namespace: 'agents', secrets: ['agents-artifacts'] },
          resource: {
            metadata: { namespace: 'agents' },
            status: {
              artifacts: [{ name: 'runner-log', url: 's3://agents-artifacts/runs/run-1.events.jsonl' }],
              runner: { telemetry: { podName: 'run-1-job-pod' } },
            },
          },
        },
      }),
    }),
  }
  return { kube, close, deps }
}

describe('retained runner log transport', () => {
  it('retrieves a bounded authenticated S3 tail after the Pod is gone', async () => {
    const f = fixture()
    const response = await getAgentRunLogsHandler(
      new Request('http://test/logs?name=run-1&namespace=agents&tailLines=1'),
      f.deps,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      source: 'artifact',
      logs: '{"event":"last"}\n',
      truncated: true,
      pod: 'run-1-job-pod',
    })
    expect(requests).toEqual([
      {
        path: '/agents-artifacts/runs/run-1.events.jsonl',
        authorization: expect.stringContaining('AWS4-HMAC-SHA256 Credential=test-access/'),
        range: 'bytes=-524288',
      },
    ])
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.kube.logs).not.toHaveBeenCalled()
  })

  it('rejects another namespace before reading storage credentials', async () => {
    const f = fixture()
    const response = await getAgentRunLogsHandler(new Request('http://test/logs?name=run-1&namespace=other'), f.deps)
    expect(response.status).toBe(404)
    expect(f.kube.get).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('rejects an explicit Pod that does not belong to the retained snapshot', async () => {
    const f = fixture()
    const response = await getAgentRunLogsHandler(
      new Request('http://test/logs?name=run-1&namespace=agents&pod=other'),
      f.deps,
    )
    expect(response.status).toBe(404)
    expect(requests).toEqual([])
  })

  it('fails instead of accepting an upstream body that ignores the byte bound', async () => {
    const f = fixture()
    oversized = true
    const response = await getAgentRunLogsHandler(new Request('http://test/logs?name=run-1&namespace=agents'), f.deps)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'retained log response exceeds its byte budget' })
  })
})
