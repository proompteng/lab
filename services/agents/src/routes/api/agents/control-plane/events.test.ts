import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '../../../../server/kube-types'
import { listPrimitiveEvents } from './events'

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

describe('listPrimitiveEvents', () => {
  it('lists events for a resolved Agents primitive kind', async () => {
    const kube = createKubeMock({
      listEvents: vi.fn(async () => ({
        items: [
          {
            metadata: { name: 'event-new', namespace: 'agents' },
            type: 'Normal',
            reason: 'Started',
            message: 'started',
            eventTime: '2026-05-19T01:00:00Z',
          },
          {
            metadata: { name: 'event-old', namespace: 'agents' },
            type: 'Warning',
            reason: 'Backoff',
            message: 'older',
            eventTime: '2026-05-19T00:00:00Z',
          },
        ],
      })),
    })

    const response = await listPrimitiveEvents(
      new Request('http://localhost/api/agents/control-plane/events?kind=AgentRun&name=run-1&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { items: Array<{ name: string }>; kind: string }
    expect(payload.kind).toBe('AgentRun')
    expect(payload.items.map((event) => event.name)).toEqual(['event-new', 'event-old'])
    expect(kube.listEvents).toHaveBeenCalledWith('agents', 'involvedObject.kind=AgentRun,involvedObject.name=run-1')
  })

  it('requires a supported kind and name', async () => {
    const missingKind = await listPrimitiveEvents(
      new Request('http://localhost/api/agents/control-plane/events?name=run-1'),
      { kubeClient: createKubeMock() },
    )
    expect(missingKind.status).toBe(400)

    const missingName = await listPrimitiveEvents(
      new Request('http://localhost/api/agents/control-plane/events?kind=AgentRun'),
      { kubeClient: createKubeMock() },
    )
    expect(missingName.status).toBe(400)
  })
})
