import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '../../../../server/kube-types'
import {
  AgentRunLogsKubeError,
  getAgentRunLogsEffect,
  makeAgentRunLogsKubeLayer,
} from '../../../../server/v1/agent-run-logs'
import { getAgentRunLogs } from './logs'

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

    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents'),
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

  it('returns ok with empty pods when none are found', async () => {
    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents'),
      { kubeClient: createKubeMock() },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.pods).toEqual([])
    expect(payload.logs).toBe('')
    expect(payload.pod).toBeNull()
  })

  it('requires name and namespace', async () => {
    const response = await getAgentRunLogs(new Request('http://localhost/api/agents/control-plane/logs?name=run-1'), {
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

    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents&pod=missing-pod'),
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

    const response = await getAgentRunLogs(
      new Request(
        'http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents&pod=agent-run-1&container=missing',
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

    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents'),
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

    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents'),
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
      getAgentRunLogsEffect(
        new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents'),
      ).pipe(Effect.provide(makeAgentRunLogsKubeLayer({ kubeClient: kube })), Effect.either),
    )

    if (result._tag !== 'Left') throw new Error('expected log read to fail')
    expect(result.left).toBeInstanceOf(AgentRunLogsKubeError)
    expect(result.left).toMatchObject({ operation: 'list-pods', namespace: 'agents', name: 'run-1' })
  })
})
