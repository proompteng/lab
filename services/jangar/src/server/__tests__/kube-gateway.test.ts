import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KubeGatewayError, createKubeGateway } from '~/server/kube-gateway'
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

  it('parses deployment rollout fields from the kubectl adapter', async () => {
    const client = createClient({
      list: vi.fn(async () => ({
        items: [
          {
            metadata: {
              name: 'agents',
              namespace: 'agents',
              generation: 3,
              labels: { app: 'agents' },
              creationTimestamp: '2026-01-20T00:00:00Z',
            },
            spec: { replicas: 2 },
            status: {
              readyReplicas: 1,
              availableReplicas: 1,
              updatedReplicas: 2,
              unavailableReplicas: 1,
              conditions: [
                { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
                { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated' },
              ],
            },
          },
        ],
      })),
    })

    const gateway = createKubeGateway(client)
    const deployments = await gateway.listDeployments('agents')

    expect(deployments).toEqual([
      {
        metadata: {
          name: 'agents',
          namespace: 'agents',
          generation: 3,
          labels: { app: 'agents' },
          creationTimestamp: '2026-01-20T00:00:00Z',
        },
        spec: { replicas: 2 },
        status: {
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 2,
          unavailableReplicas: 1,
          conditions: [
            {
              type: 'Available',
              status: 'False',
              reason: 'MinimumReplicasUnavailable',
              lastTransitionTime: null,
            },
            {
              type: 'Progressing',
              status: 'True',
              reason: 'ReplicaSetUpdated',
              lastTransitionTime: null,
            },
          ],
        },
      },
    ])
    expect(client.list).toHaveBeenCalledWith('deployments', 'agents')
  })

  it('forwards job selectors and normalizes job metadata', async () => {
    const client = createClient({
      list: vi.fn(async () => ({
        items: [
          {
            metadata: {
              name: 'swarm-plan-123',
              namespace: 'agents',
              labels: {
                'swarm.proompteng.ai/name': 'jangar-control-plane',
                'schedules.proompteng.ai/schedule': 'plan',
              },
              creationTimestamp: '2026-01-20T00:00:00Z',
            },
            status: {
              active: 1,
              failed: 0,
              startTime: '2026-01-20T00:01:00Z',
              conditions: [{ type: 'Complete', status: 'False', reason: 'Running' }],
            },
          },
        ],
      })),
    })

    const gateway = createKubeGateway(client)
    const jobs = await gateway.listJobs('agents', 'schedules.proompteng.ai/schedule')

    expect(jobs[0]?.metadata.labels).toEqual({
      'swarm.proompteng.ai/name': 'jangar-control-plane',
      'schedules.proompteng.ai/schedule': 'plan',
    })
    expect(jobs[0]?.status.active).toBe(1)
    expect(client.list).toHaveBeenCalledWith('jobs.batch', 'agents', 'schedules.proompteng.ai/schedule')
  })

  it('classifies transport failures', async () => {
    const gateway = createKubeGateway(
      createClient({
        list: vi.fn(async () => {
          throw new Error('kubectl unavailable')
        }),
      }),
    )

    await expect(gateway.listSwarms('agents')).rejects.toMatchObject({
      name: 'KubeGatewayError',
      kind: 'transport',
      message: 'kube swarms list failed: kubectl unavailable',
    } satisfies Partial<KubeGatewayError>)
  })

  it('classifies invalid list payloads', async () => {
    const gateway = createKubeGateway(
      createClient({
        list: vi.fn(async () => ({ ok: true })),
      }),
    )

    await expect(gateway.listDeployments('agents')).rejects.toMatchObject({
      name: 'KubeGatewayError',
      kind: 'invalid_payload',
      message: 'kube deployments list returned invalid list payload',
    } satisfies Partial<KubeGatewayError>)
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

  it('classifies namespaced resource access results', async () => {
    const gateway = createKubeGateway(
      createClient({
        list: vi
          .fn()
          .mockResolvedValueOnce({ items: [] })
          .mockRejectedValueOnce(new Error('kubernetes list failed: Error from server (Forbidden): forbidden'))
          .mockRejectedValueOnce(
            new Error('kubernetes list failed: the server does not have a resource type "swarms.swarm.proompteng.ai"'),
          ),
      }),
    )

    await expect(gateway.probeNamespacedResource('tools.tools.proompteng.ai', 'agents')).resolves.toBe('ok')
    await expect(gateway.probeNamespacedResource('tools.tools.proompteng.ai', 'agents')).resolves.toBe('forbidden')
    await expect(gateway.probeNamespacedResource('swarms.swarm.proompteng.ai', 'agents')).resolves.toBe('missing')
  })
})
