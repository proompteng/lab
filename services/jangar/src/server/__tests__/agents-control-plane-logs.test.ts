import { describe, expect, it, vi } from 'vitest'

import { getAgentRunLogs } from '~/routes/api/agents/control-plane/logs'

const buildPod = (name: string, phase: string, containers: string[], initContainers: string[] = []) => ({
  metadata: { name },
  status: { phase },
  spec: {
    containers: containers.map((container) => ({ name: container })),
    initContainers: initContainers.map((container) => ({ name: container })),
  },
})

describe('control plane logs route', () => {
  it('returns pods and logs for the selected pod', async () => {
    const kube = {
      list: vi.fn(async () => ({
        items: [
          buildPod('agent-run-1', 'Running', ['runner'], ['init-seed']),
          buildPod('agent-run-2', 'Pending', ['runner']),
        ],
      })),
      logs: vi.fn(async () => 'log output'),
    }

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
    expect(Array.isArray(payload.pods)).toBe(true)
    expect(kube.logs).toHaveBeenCalledWith({
      pod: 'agent-run-1',
      namespace: 'agents',
      container: 'runner',
      tailLines: null,
    })
  })

  it('returns ok with empty pods when none are found', async () => {
    const kube = {
      list: vi.fn(async () => ({ items: [] })),
      logs: vi.fn(),
    }

    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.pods).toEqual([])
    expect(payload.logs).toBe('')
    expect(payload.pod).toBeNull()
  })

  it('requires name and namespace', async () => {
    const response = await getAgentRunLogs(
      new Request('http://localhost/api/agents/control-plane/logs?name=run-1'),
      { kubeClient: { list: vi.fn(), logs: vi.fn() } },
    )

    expect(response.status).toBe(400)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.error).toBe('namespace is required')
  })
})
