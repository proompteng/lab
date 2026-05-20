import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createKubeGateway } from '~/server/kube-gateway'
import type { KubernetesClient } from '~/server/primitives-kube'

const createClient = (overrides: Partial<KubernetesClient>): KubernetesClient =>
  ({
    apply: vi.fn(),
    applyManifest: vi.fn(),
    applyStatus: vi.fn(),
    createManifest: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    listEvents: vi.fn(),
    logs: vi.fn(),
    ...overrides,
  }) as unknown as KubernetesClient

describe('kube gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists namespaces through the shared kubernetes client boundary', async () => {
    const client = createClient({
      list: vi.fn(async () => ({
        items: [{ metadata: { name: 'agents' } }, { metadata: { name: 'torghut' } }],
      })),
    })
    const gateway = createKubeGateway(client)

    await expect(gateway.listNamespaces()).resolves.toEqual(['agents', 'torghut'])
    expect(client.list).toHaveBeenCalledWith('namespaces', '')
  })

  it('gets, creates, and replaces leases through the shared kubernetes client boundary', async () => {
    const applyMock = vi
      .fn()
      .mockResolvedValueOnce({
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: 'jangar-controller-leader', namespace: 'agents', resourceVersion: '8' },
        spec: { holderIdentity: 'pod-1', leaseDurationSeconds: 30 },
      })
      .mockResolvedValueOnce({
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: 'jangar-controller-leader', namespace: 'agents', resourceVersion: '9' },
        spec: { holderIdentity: 'pod-2', leaseDurationSeconds: 30 },
      })
    const client = createClient({
      get: vi.fn(async () => ({
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: 'jangar-controller-leader', namespace: 'agents', resourceVersion: '7' },
        spec: { holderIdentity: 'pod-1', leaseDurationSeconds: 30 },
      })),
      apply: applyMock,
    })
    const gateway = createKubeGateway(client)

    await expect(gateway.getLease('agents', 'jangar-controller-leader')).resolves.toMatchObject({
      metadata: { name: 'jangar-controller-leader', resourceVersion: '7' },
    })
    await expect(
      gateway.createLease('agents', {
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: 'jangar-controller-leader', namespace: 'agents' },
        spec: { holderIdentity: 'pod-1', leaseDurationSeconds: 30 },
      }),
    ).resolves.toMatchObject({ metadata: { resourceVersion: '8' } })
    await expect(
      gateway.replaceLease('agents', {
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: 'jangar-controller-leader', namespace: 'agents', resourceVersion: '8' },
        spec: { holderIdentity: 'pod-2', leaseDurationSeconds: 30 },
      }),
    ).resolves.toMatchObject({ metadata: { resourceVersion: '9' } })
    expect(client.get).toHaveBeenCalledWith('lease', 'jangar-controller-leader', 'agents')
    expect(client.apply).toHaveBeenCalledTimes(2)
    expect(client.apply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: expect.objectContaining({ name: 'jangar-controller-leader', namespace: 'agents' }),
      }),
    )
  })
})
