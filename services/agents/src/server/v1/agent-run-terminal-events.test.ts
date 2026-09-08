import { describe, expect, it, vi } from 'vitest'

import { ackAgentRunTerminalEvent, listAgentRunTerminalEvents } from './agent-run-terminal-events'
import type { KubernetesClient } from '../kube-types'

const buildAgentRun = (
  overrides: {
    name?: string
    namespace?: string
    uid?: string
    phase?: string
    runId?: string
    finishedAt?: string
    annotations?: Record<string, string>
  } = {},
) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name: overrides.name ?? 'run-1',
    namespace: overrides.namespace ?? 'agents',
    uid: overrides.uid ?? 'uid-1',
    annotations: overrides.annotations ?? {},
    creationTimestamp: '2026-05-20T00:00:00.000Z',
  },
  spec: {
    parameters: {
      runId: overrides.runId ?? overrides.name ?? 'run-1',
    },
  },
  status: {
    phase: overrides.phase ?? 'Succeeded',
    finishedAt: overrides.finishedAt ?? '2026-05-20T00:00:00.000Z',
  },
})

const makeKubeClient = (overrides: Partial<KubernetesClient>): KubernetesClient =>
  ({
    apply: vi.fn(),
    applyManifest: vi.fn(),
    applyStatus: vi.fn(),
    createManifest: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    listEvents: vi.fn(),
    logs: vi.fn(),
    patch: vi.fn(),
    ...overrides,
  }) as unknown as KubernetesClient

describe('agent-run terminal events API', () => {
  it('lists unacked terminal AgentRun events by consumer and run id prefix', async () => {
    const kubeClient = makeKubeClient({
      list: vi.fn(async () => ({
        items: [
          buildAgentRun({
            name: 'run-older',
            runId: 'run-older',
            finishedAt: '2026-05-20T01:00:00.000Z',
          }),
          buildAgentRun({
            name: 'run-newer',
            runId: 'run-newer',
            finishedAt: '2026-05-20T02:00:00.000Z',
          }),
          buildAgentRun({
            name: 'run-acked',
            runId: 'run-acked',
            annotations: {
              'agents.proompteng.ai/terminal-ack.finalizer.succeeded.at': '2026-05-20T03:00:00.000Z',
            },
          }),
          buildAgentRun({ name: 'run-active', phase: 'Running', runId: 'run-active' }),
          buildAgentRun({ name: 'other-run', runId: 'other-run' }),
        ],
      })),
    })

    const response = await listAgentRunTerminalEvents(
      new Request(
        'http://agents.test/v1/agent-runs/terminal-events?namespace=agents&runIdPrefix=run-&consumer=finalizer',
      ),
      { kubeClient },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(kubeClient.list).toHaveBeenCalledWith('agentruns.agents.proompteng.ai', 'agents')
    expect(body).toMatchObject({
      ok: true,
      namespace: 'agents',
      consumer: 'finalizer',
      total: 2,
    })
    expect(body.events.map((event: { name: string }) => event.name)).toEqual(['run-newer', 'run-older'])
  })

  it('acks a terminal AgentRun event by patching consumer-specific annotations', async () => {
    const resource = buildAgentRun({ name: 'run-1', uid: 'uid-1', phase: 'Succeeded' })
    const patched = buildAgentRun({
      name: 'run-1',
      uid: 'uid-1',
      phase: 'Succeeded',
      annotations: {
        'agents.proompteng.ai/terminal-ack.finalizer.succeeded.outcome': 'finalized',
      },
    })
    const kubeClient = makeKubeClient({
      get: vi.fn(async () => resource),
      patch: vi.fn(async () => patched),
    })

    const response = await ackAgentRunTerminalEvent(
      new Request('http://agents.test/v1/agent-runs/terminal-events/ack', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'agents/run-1/uid-1/Succeeded',
          consumer: 'finalizer',
          outcome: 'finalized',
          message: 'done',
          receiptRef: 'receipt-1',
        }),
      }),
      { kubeClient },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(kubeClient.patch).toHaveBeenCalledWith('agentruns.agents.proompteng.ai', 'run-1', 'agents', {
      metadata: {
        annotations: expect.objectContaining({
          'agents.proompteng.ai/terminal-ack.finalizer.succeeded.outcome': 'finalized',
          'agents.proompteng.ai/terminal-ack.finalizer.succeeded.message': 'done',
          'agents.proompteng.ai/terminal-ack.finalizer.succeeded.receipt': 'receipt-1',
        }),
      },
    })
    expect(body).toMatchObject({
      ok: true,
      eventId: 'agents/run-1/uid-1/Succeeded',
      name: 'run-1',
      namespace: 'agents',
      consumer: 'finalizer',
    })
  })

  it('rejects stale terminal event acks with conflict status', async () => {
    const kubeClient = makeKubeClient({
      get: vi.fn(async () => buildAgentRun({ name: 'run-1', uid: 'uid-1', phase: 'Failed' })),
    })

    const response = await ackAgentRunTerminalEvent(
      new Request('http://agents.test/v1/agent-runs/terminal-events/ack', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'agents/run-1/uid-1/Succeeded',
          consumer: 'finalizer',
        }),
      }),
      { kubeClient },
    )
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      ok: false,
      error: 'terminal AgentRun event phase is stale',
      details: { eventId: 'agents/run-1/uid-1/Succeeded' },
    })
  })
})
