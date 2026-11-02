import { describe, expect, it, vi } from 'vitest'

import {
  getAgentRunProjectionAuthorityHandler,
  type AgentRunProjectionAuthorityDeps,
} from './agent-run-projection-authority'
import type { AgentRunsApiStore } from './agent-run-store'

const fixedNow = new Date('2026-05-20T12:00:00.000Z')

const createStore = (runs: unknown[]): AgentRunsApiStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listAgentRuns: vi.fn(async () => runs),
  }) as unknown as AgentRunsApiStore

const depsFor = (store: AgentRunsApiStore): AgentRunProjectionAuthorityDeps => ({
  storeFactory: () => store,
  now: () => fixedNow,
})

describe('AgentRun projection authority API', () => {
  it('classifies active AgentRun records as stale, current, or grace in Agents', async () => {
    const store = createStore([
      {
        id: 'stale-run',
        agentName: 'codex-worker',
        deliveryId: 'delivery-stale',
        provider: 'job',
        status: 'Running',
        externalRunId: 'agentrun-stale',
        payload: {},
        createdAt: '2026-05-20T01:00:00.000Z',
        updatedAt: '2026-05-20T02:00:00.000Z',
      },
      {
        id: 'current-run',
        agentName: 'codex-worker',
        deliveryId: 'delivery-current',
        provider: 'job',
        status: 'Running',
        externalRunId: 'agentrun-current',
        payload: { timeoutSeconds: 86_400 },
        createdAt: '2026-05-20T01:00:00.000Z',
        updatedAt: '2026-05-20T02:00:00.000Z',
      },
      {
        id: 'unknown-run',
        agentName: 'codex-worker',
        deliveryId: 'delivery-unknown',
        provider: 'job',
        status: 'WaitingForHuman',
        externalRunId: null,
        payload: {},
        createdAt: '2026-05-20T11:00:00.000Z',
        updatedAt: '2026-05-20T11:00:00.000Z',
      },
    ])

    const response = await getAgentRunProjectionAuthorityHandler(
      new Request('http://agents.test/v1/agent-runs/projection-authority?agentName=codex-worker&limit=25'),
      depsFor(store),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(store.listAgentRuns).toHaveBeenCalledWith({
      agentName: 'codex-worker',
      statuses: expect.arrayContaining(['running', 'RUNNING', 'Running']),
      limit: 25,
    })
    expect(body).toMatchObject({
      ok: true,
      schemaVersion: 'agents.agentrun-projection-authority.v1',
      generatedAt: fixedNow.toISOString(),
      total: 3,
    })
    expect(body.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_ref: 'agent_runs:stale-run',
          authority_state: 'stale_foreclosed',
          reason_codes: ['agents_service_agentrun_projection_not_renewed'],
        }),
        expect.objectContaining({
          source_ref: 'agent_runs:current-run',
          authority_state: 'authoritative',
          reason_codes: ['agents_service_agentrun_projection_current'],
        }),
        expect.objectContaining({
          source_ref: 'agent_runs:unknown-run',
          authority_state: 'grace',
          reason_codes: ['agents_service_agentrun_projection_inside_grace_budget'],
        }),
      ]),
    )
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('includes terminal audit claims only when requested', async () => {
    const terminalRun = {
      id: 'terminal-run',
      agentName: 'codex-worker',
      deliveryId: 'delivery-terminal',
      provider: 'job',
      status: 'Succeeded',
      externalRunId: 'agentrun-terminal',
      payload: {},
      createdAt: '2026-05-20T10:00:00.000Z',
      updatedAt: '2026-05-20T10:30:00.000Z',
    }
    const store = createStore([terminalRun])

    const response = await getAgentRunProjectionAuthorityHandler(
      new Request('http://agents.test/v1/agent-runs/projection-authority?includeTerminalAudit=true'),
      depsFor(store),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(store.listAgentRuns).toHaveBeenCalledWith({ agentName: null, statuses: null, limit: 100 })
    expect(body.claims).toEqual([
      expect.objectContaining({
        source_ref: 'agent_runs:terminal-run',
        authority_state: 'terminal_audit',
        fresh_until: null,
      }),
    ])
  })

  it('classifies Failed terminal AgentRuns as terminal_audit for missing Job without runner status', async () => {
    const failedRun = {
      id: 'failed-missing-job',
      agentName: 'codex-worker',
      deliveryId: 'delivery-failed',
      provider: 'job',
      status: 'Failed',
      externalRunId: 'agentrun-failed',
      payload: {},
      createdAt: '2026-05-20T09:00:00.000Z',
      updatedAt: '2026-05-20T10:00:00.000Z',
    }
    const store = createStore([failedRun])

    const response = await getAgentRunProjectionAuthorityHandler(
      new Request('http://agents.test/v1/agent-runs/projection-authority?includeTerminalAudit=true'),
      depsFor(store),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(store.listAgentRuns).toHaveBeenCalledWith({ agentName: null, statuses: null, limit: 100 })
    expect(body.claims).toEqual([
      expect.objectContaining({
        source_ref: 'agent_runs:failed-missing-job',
        authority_state: 'terminal_audit',
        status: 'failed',
        reason_codes: expect.arrayContaining(['agents_service_agentrun_projection_terminal_audit']),
      }),
    ])
  })
})
