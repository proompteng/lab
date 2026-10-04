import { describe, expect, it, vi } from 'vitest'

import { createKubeGateway, KubeGatewayError } from './kube-gateway'
import type { KubernetesClient } from './kube-types'

const fakeClient = (overrides: Partial<KubernetesClient>): KubernetesClient => overrides as unknown as KubernetesClient

describe('kube gateway', () => {
  it('categorizes invalid AgentRun list payloads', async () => {
    const gateway = createKubeGateway(
      fakeClient({
        list: vi.fn().mockResolvedValue({}),
      }),
    )

    await expect(gateway.listAgentRuns('agents')).rejects.toMatchObject({
      name: 'KubeGatewayError',
      kind: 'invalid_payload',
      message: 'kube agentruns list returned invalid list payload',
    })
  })

  it('wraps Job list transport errors', async () => {
    const cause = new Error('apiserver unavailable')
    const gateway = createKubeGateway(
      fakeClient({
        list: vi.fn().mockRejectedValue(cause),
      }),
    )

    await expect(gateway.listJobs('agents')).rejects.toMatchObject({
      name: 'KubeGatewayError',
      kind: 'transport',
      message: 'kube jobs list failed: apiserver unavailable',
      cause,
    })
  })

  it('returns null for missing Leases', async () => {
    const get = vi.fn().mockRejectedValue(new Error('leases.coordination.k8s.io "agents-leader" not found'))
    const gateway = createKubeGateway(fakeClient({ get }))

    await expect(gateway.getLease('agents', 'agents-leader')).resolves.toBeNull()
    expect(get).toHaveBeenCalledWith('lease', 'agents-leader', 'agents')
  })

  it('categorizes namespaced resource probes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error('forbidden: User cannot list resource'))
      .mockRejectedValueOnce(new Error('the server could not find the requested resource'))
    const gateway = createKubeGateway(fakeClient({ list }))

    await expect(gateway.probeNamespacedResource('jobs.batch', 'agents')).resolves.toBe('ok')
    await expect(gateway.probeNamespacedResource('jobs.batch', 'agents')).resolves.toBe('forbidden')
    await expect(gateway.probeNamespacedResource('missing.example.com', 'agents')).resolves.toBe('missing')
  })

  it('keeps public gateway errors as Error instances', async () => {
    const gateway = createKubeGateway(
      fakeClient({
        list: vi.fn().mockResolvedValue({}),
      }),
    )

    await expect(gateway.listAgentRuns('agents')).rejects.toBeInstanceOf(KubeGatewayError)
  })
})
