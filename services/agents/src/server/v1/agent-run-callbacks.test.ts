import { describe, expect, it, vi } from 'vitest'

import type { AgentRunRecord } from '../primitives-store'

import { postAgentRunCallbacksHandler, type AgentRunCallbacksApiDependencies } from './agent-run-callbacks'

const parentRun: AgentRunRecord = {
  id: 'agent-run-record-1',
  agentName: 'codex',
  deliveryId: 'agent-run-delivery-1',
  provider: 'job',
  status: 'Running',
  externalRunId: 'agent-run-1',
  payload: {
    resource: {
      metadata: {
        name: 'agent-run-1',
        namespace: 'agents',
        uid: 'agent-run-uid-1',
      },
    },
  },
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
}

const createStore = (overrides: Record<string, unknown> = {}) =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listAgentRuns: vi.fn(async () => []),
    getAgentRunById: vi.fn(async (id: string) => (id === parentRun.id ? parentRun : null)),
    getAgentRunByExternalRunId: vi.fn(async (externalRunId: string) =>
      externalRunId === parentRun.externalRunId ? parentRun : null,
    ),
    getAgentRunByDeliveryId: vi.fn(async () => null),
    getAgentRunIdempotencyKey: vi.fn(async () => null),
    reserveAgentRunIdempotencyKey: vi.fn(async () => ({ record: {}, created: true })),
    deleteAgentRunIdempotencyKey: vi.fn(async () => true),
    assignAgentRunIdempotencyKey: vi.fn(async () => null),
    createAgentRun: vi.fn(async (input) => ({ id: 'unused-agent-run', ...input })),
    updateAgentRunDetails: vi.fn(async (input) => ({ ...parentRun, status: input.status, payload: input.payload })),
    createAuditEvent: vi.fn(async () => ({})),
    ...overrides,
  }) as unknown as AgentRunCallbacksApiDependencies['storeFactory'] extends () => infer Store ? Store : never

const request = (payload: Record<string, unknown>) =>
  new Request('http://agents.local/v1/agent-runs/agent-run-record-1/callbacks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('AgentRun callbacks v1 API', () => {
  it('ingests run-complete callbacks into the Agents AgentRun projection', async () => {
    const store = createStore()

    const response = await postAgentRunCallbacksHandler(
      'agent-run-record-1',
      request({
        callbackType: 'run_complete',
        metadata: {
          name: 'agent-run-1',
          namespace: 'agents',
          uid: 'agent-run-uid-1',
          labels: {
            repository: 'proompteng/lab',
            issue_number: '7152',
            head: 'codex/agents-split',
          },
        },
        status: { phase: 'Succeeded' },
        artifacts: [{ name: 'status', key: 'runs/status.json' }],
      }),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ ok: true, callbackType: 'run_complete' })
    expect(store.updateAgentRunDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-run-record-1',
        status: 'Succeeded',
        payload: expect.objectContaining({
          agentRunName: 'agent-run-1',
          agentRunNamespace: 'agents',
          agentRunUid: 'agent-run-uid-1',
          callbacks: expect.objectContaining({
            run_complete: expect.objectContaining({
              payload: expect.objectContaining({
                metadata: expect.objectContaining({
                  name: 'agent-run-1',
                  namespace: 'agents',
                }),
              }),
            }),
          }),
        }),
      }),
    )
    expect(store.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'AgentRun',
        entityId: 'agent-run-record-1',
        eventType: 'agent_run.callback_received',
      }),
    )
  })

  it('ingests notify callbacks by external AgentRun name', async () => {
    const store = createStore()

    const response = await postAgentRunCallbacksHandler(
      'agent-run-1',
      request({
        callbackType: 'notify',
        agent_run_name: 'agent-run-1',
        agent_run_namespace: 'agents',
        repository: 'proompteng/lab',
        issue_number: 7152,
        branch: 'codex/agents-split',
        pr_url: 'https://github.com/proompteng/lab/pull/7299',
      }),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.getAgentRunByExternalRunId).toHaveBeenCalledWith('agent-run-1')
    expect(store.updateAgentRunDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'Running',
        payload: expect.objectContaining({
          callbacks: expect.objectContaining({
            notify: expect.objectContaining({
              payload: expect.objectContaining({ pr_url: 'https://github.com/proompteng/lab/pull/7299' }),
            }),
          }),
        }),
      }),
    )
  })
})
