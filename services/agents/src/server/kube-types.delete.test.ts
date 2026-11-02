import { once } from 'node:events'
import { createServer } from 'node:http'

import { KubeConfig } from '@kubernetes/client-node'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKubernetesClient } from './kube-types'

const requests: Array<{ url: string | undefined; body: unknown }> = []
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.method === 'GET') {
    response.end(
      JSON.stringify({
        kind: 'APIResourceList',
        apiVersion: 'v1',
        groupVersion: 'batch/v1',
        resources: [{ name: 'jobs', kind: 'Job', namespaced: true, verbs: ['delete'] }],
      }),
    )
    return
  }
  request.setEncoding('utf8')
  let body = ''
  for await (const chunk of request) body += chunk
  requests.push({ url: request.url, body: JSON.parse(body) })
  response.end(JSON.stringify({ apiVersion: 'v1', kind: 'Status', status: 'Success', code: 200 }))
})

beforeAll(async () => {
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const url = `http://127.0.0.1:${address.port}`
  Reflect.deleteProperty(globalThis, '__agentsNativeKubeClients')
  vi.spyOn(KubeConfig.prototype, 'loadFromDefault').mockImplementation(function (this: KubeConfig) {
    this.loadFromOptions({
      clusters: [{ name: 'test', server: url, skipTLSVerify: true }],
      users: [{ name: 'test' }],
      contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
      currentContext: 'test',
    })
  })
})

beforeEach(() => {
  requests.length = 0
})

afterAll(async () => {
  Reflect.deleteProperty(globalThis, '__agentsNativeKubeClients')
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

describe('Kubernetes DELETE wire contract', () => {
  it.each([
    { options: { uid: 'run-uid' }, grace: undefined },
    { options: { uid: 'run-uid', wait: false }, grace: 0 },
    { options: { uid: 'run-uid', wait: false, timeoutSeconds: 7 }, grace: 7 },
  ])('sends cascade, identity and grace in the body: $options', async ({ options, grace }) => {
    await createKubernetesClient().delete('job', 'probe', 'agents', options)
    expect(requests).toEqual([
      {
        url: '/apis/batch/v1/namespaces/agents/jobs/probe',
        body: {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          propagationPolicy: 'Background',
          preconditions: { uid: 'run-uid' },
          ...(grace === undefined ? {} : { gracePeriodSeconds: grace }),
        },
      },
    ])
  })
})
