import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '../kube-types'
import {
  AgentRunLogsKubeError,
  getAgentRunLogsEffect,
  makeAgentRunLogsKubeLayer,
  getAgentRunLogsHandler,
} from './agent-run-logs'

const buildPod = (name: string, phase: string, containers: string[], initContainers: string[] = []) => ({
  metadata: { name },
  status: { phase },
  spec: {
    containers: containers.map((container) => ({ name: container })),
    initContainers: initContainers.map((container) => ({ name: container })),
  },
})

const createKubeMock = (overrides: Partial<KubernetesClient> = {}): KubernetesClient => ({
  apply: vi.fn(async (resource) => resource),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
  listEvents: vi.fn(async () => ({ items: [] })),
  ...overrides,
})

describe('getAgentRunLogs', () => {
  it('restricts connector logs to the recorded run UID and rejects a changed target', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => ({ items: [buildPod('original-pod', 'Running', ['runner'])] })),
      logs: vi.fn(async () => 'original logs'),
    })
    const record = {
      id: 'projection',
      agentName: 'agent',
      deliveryId: 'delivery',
      provider: 'job',
      status: 'Running',
      externalRunId: 'run-1',
      payload: { request: { namespace: 'agents' }, resource: { metadata: { uid: 'original-uid' } } },
    }
    const response = await getAgentRunLogsHandler(
      new Request('http://agents/logs?name=run-1&namespace=agents&tailLines=1'),
      { kubeClient: kube, record, maxBytes: 131072 },
    )
    expect(response.status).toBe(200)
    expect(kube.list).toHaveBeenCalledWith(
      'pods',
      'agents',
      'agents.proompteng.ai/agent-run=run-1,agents.proompteng.ai/run-uid=original-uid',
    )
    expect(kube.logs).toHaveBeenCalledWith(expect.objectContaining({ limitBytes: 131072, tailLines: 1 }))
    vi.mocked(kube.logs).mockClear()
    const changed = await getAgentRunLogsHandler(new Request('http://agents/logs?name=run-1&namespace=other'), {
      kubeClient: kube,
      record,
    })
    expect(changed.status).toBe(502)
    expect(kube.logs).not.toHaveBeenCalled()
  })

  it('returns pods and logs for the selected pod', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => ({
        items: [
          buildPod('agent-run-1', 'Running', ['runner'], ['init-seed']),
          buildPod('agent-run-2', 'Pending', ['runner']),
        ],
      })),
      logs: vi.fn(async () => 'log output'),
    })

    const response = await getAgentRunLogsHandler(
      new Request('http://localhost/v1/control-plane/logs?name=run-1&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.pod).toBe('agent-run-1')
    expect(payload.container).toBe('runner')
    expect(payload.logs).toBe('log output')
    expect(kube.logs).toHaveBeenCalledWith({
      pod: 'agent-run-1',
      namespace: 'agents',
      container: 'runner',
      tailLines: null,
    })
  })

  it('reports unavailable logs when neither a live Pod nor a retained run exists', async () => {
    const response = await getAgentRunLogsHandler(
      new Request('http://localhost/v1/control-plane/logs?name=run-1&namespace=agents'),
      {
        kubeClient: createKubeMock(),
        storeFactory: () => ({
          ready: Promise.resolve(),
          close: async () => {},
          getAgentRunByExternalRunId: async () => null,
        }),
      },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'AgentRun logs not found' })
  })

  it('requires name and namespace', async () => {
    const response = await getAgentRunLogsHandler(new Request('http://localhost/v1/control-plane/logs?name=run-1'), {
      kubeClient: createKubeMock(),
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.error).toBe('namespace is required')
  })

  it('returns 404 for an explicit unknown pod without reading logs', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => ({ items: [buildPod('agent-run-1', 'Running', ['runner'])] })),
      logs: vi.fn(async () => 'log output'),
    })

    const response = await getAgentRunLogsHandler(
      new Request('http://localhost/v1/control-plane/logs?name=run-1&namespace=agents&pod=missing-pod'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'pod not found',
      details: { name: 'run-1', namespace: 'agents', pod: 'missing-pod' },
    })
    expect(kube.logs).not.toHaveBeenCalled()
  })

  it('returns 404 for an explicit unknown container without falling back to the runner container', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => ({ items: [buildPod('agent-run-1', 'Running', ['runner'])] })),
      logs: vi.fn(async () => 'log output'),
    })

    const response = await getAgentRunLogsHandler(
      new Request(
        'http://localhost/v1/control-plane/logs?name=run-1&namespace=agents&pod=agent-run-1&container=missing',
      ),
      { kubeClient: kube },
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'container not found',
      details: { name: 'run-1', namespace: 'agents', pod: 'agent-run-1', container: 'missing' },
    })
    expect(kube.logs).not.toHaveBeenCalled()
  })

  it('maps Kubernetes pod list failures to a typed 502 response', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => {
        throw new Error('list denied')
      }),
    })

    const response = await getAgentRunLogsHandler(
      new Request('http://localhost/v1/control-plane/logs?name=run-1&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: 'kubernetes list-pods failed for AgentRun agents/run-1: list denied',
      details: { name: 'run-1', namespace: 'agents', operation: 'list-pods' },
    })
  })

  it('maps Kubernetes pod log failures to a typed 502 response', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => ({ items: [buildPod('agent-run-1', 'Running', ['runner'])] })),
      logs: vi.fn(async () => {
        throw new Error('logs denied')
      }),
    })

    const response = await getAgentRunLogsHandler(
      new Request('http://localhost/v1/control-plane/logs?name=run-1&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: 'kubernetes read-pod-logs failed for AgentRun agents/run-1: logs denied',
      details: { name: 'run-1', namespace: 'agents', operation: 'read-pod-logs' },
    })
  })

  it('exposes typed Effect errors for direct service callers', async () => {
    const kube = createKubeMock({
      list: vi.fn(async () => {
        throw new Error('list denied')
      }),
    })

    const result = await Effect.runPromise(
      getAgentRunLogsEffect(new Request('http://localhost/v1/control-plane/logs?name=run-1&namespace=agents')).pipe(
        Effect.provide(makeAgentRunLogsKubeLayer({ kubeClient: kube })),
        Effect.either,
      ),
    )

    if (result._tag !== 'Left') throw new Error('expected log read to fail')
    expect(result.left).toBeInstanceOf(AgentRunLogsKubeError)
    expect(result.left).toMatchObject({ operation: 'list-pods', namespace: 'agents', name: 'run-1' })
  })
})
