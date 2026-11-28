import { once } from 'node:events'
import { createServer } from 'node:http'

import { KubeConfig } from '@kubernetes/client-node'
import { expect, it, vi } from 'vitest'

import { createKubernetesClient, isKubeConflict } from '../kube-types'

it('sends the observed AgentRun revision to /status and exposes Kubernetes conflicts', async () => {
  const requests: Array<{
    method: string | undefined
    path: string | undefined
    contentType: string | undefined
    body: string
  }> = []
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8')
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, path: request.url, contentType: request.headers['content-type'], body })
    response.writeHead(409, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Conflict', code: 409 }))
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const load = vi.spyOn(KubeConfig.prototype, 'loadFromDefault').mockImplementation(function (this: KubeConfig) {
    this.loadFromOptions({
      clusters: [{ name: 'test', server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true }],
      users: [{ name: 'test' }],
      contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
      currentContext: 'test',
    })
  })
  Reflect.deleteProperty(globalThis, '__agentsNativeKubeClients')
  try {
    const kube = createKubernetesClient()
    const resource = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: { name: 'run', namespace: 'agents' },
      status: { phase: 'Running' },
    }
    await expect(kube.applyStatus(resource)).rejects.toThrow('require the reconciled resourceVersion')
    const patch = { ...resource, metadata: { ...resource.metadata, resourceVersion: '90071992547409931' } }
    await expect(kube.applyStatus(patch)).rejects.toSatisfy(isKubeConflict)
    expect(requests).toEqual([
      {
        method: 'PATCH',
        path: '/apis/agents.proompteng.ai/v1alpha1/namespaces/agents/agentruns/run/status?fieldManager=agents-status',
        contentType: 'application/merge-patch+json',
        body: expect.any(String),
      },
    ])
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual(patch)
  } finally {
    Reflect.deleteProperty(globalThis, '__agentsNativeKubeClients')
    load.mockRestore()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
