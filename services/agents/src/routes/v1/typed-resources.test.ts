import { describe, expect, it, vi } from 'vitest'

import { getMemoryResource } from './memories/resources'
import { postSignalResource } from './signals/resources'
import { listSwarmResources } from './swarms/resources'

const asKube = <T>(kube: T) => kube as unknown as NonNullable<Parameters<typeof listSwarmResources>[1]>['kubeClient']

describe('Agents v1 typed resource routes', () => {
  it('forces the Swarm kind even when callers send the old generic kind selector', async () => {
    const kube = {
      list: vi.fn(async () => ({
        items: [{ kind: 'Swarm', metadata: { name: 'market-swarm', namespace: 'agents' } }],
      })),
    }

    const response = await listSwarmResources(
      new Request('http://agents.local/v1/swarms/resources?namespace=agents&kind=AgentRun&limit=10'),
      { kubeClient: asKube(kube) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      kind: 'Swarm',
      namespace: 'agents',
      items: [{ kind: 'Swarm', metadata: { name: 'market-swarm', namespace: 'agents' } }],
    })
    expect(kube.list).toHaveBeenCalledWith('swarms.swarm.proompteng.ai', 'agents', undefined)
  })

  it('forces the Memory kind for named typed resource reads', async () => {
    const kube = {
      get: vi.fn(async () => ({
        kind: 'Memory',
        metadata: { name: 'team-context', namespace: 'agents' },
      })),
    }

    const response = await getMemoryResource(
      new Request('http://agents.local/v1/memories/resources?name=team-context&namespace=agents&kind=Signal'),
      { kubeClient: asKube(kube) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      kind: 'Memory',
      namespace: 'agents',
      resource: { kind: 'Memory', metadata: { name: 'team-context', namespace: 'agents' } },
    })
    expect(kube.get).toHaveBeenCalledWith('memories.agents.proompteng.ai', 'team-context', 'agents')
  })

  it('applies Signal resources through the typed route', async () => {
    const kube = {
      apply: vi.fn(async (resource: Record<string, unknown>) => resource),
    }

    const response = await postSignalResource(
      new Request('http://agents.local/v1/signals/resources?kind=AgentRun', {
        body: JSON.stringify({
          apiVersion: 'signals.proompteng.ai/v1alpha1',
          kind: 'Signal',
          metadata: { name: 'requirement-a', namespace: 'agents' },
          spec: { channel: 'nats' },
        }),
        headers: { 'idempotency-key': 'signal-delivery-a' },
        method: 'POST',
      }),
      { kubeClient: asKube(kube) },
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      kind: 'Signal',
      namespace: 'agents',
      resource: {
        kind: 'Signal',
        metadata: {
          name: 'requirement-a',
          namespace: 'agents',
          labels: {
            'agents.proompteng.ai/delivery-id': 'signal-delivery-a',
          },
        },
      },
    })
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'Signal',
        metadata: expect.objectContaining({ name: 'requirement-a', namespace: 'agents' }),
      }),
    )
  })

  it('rejects raw resources with the wrong kind on a typed route', async () => {
    const kube = {
      apply: vi.fn(async (resource: Record<string, unknown>) => resource),
    }

    const response = await postSignalResource(
      new Request('http://agents.local/v1/signals/resources', {
        body: JSON.stringify({
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          metadata: { name: 'wrong-kind', namespace: 'agents' },
          spec: {},
        }),
        headers: { 'idempotency-key': 'wrong-kind' },
        method: 'POST',
      }),
      { kubeClient: asKube(kube) },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'kind must be Signal' })
    expect(kube.apply).not.toHaveBeenCalled()
  })
})
