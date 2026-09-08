import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchAgentRunProjectionAuthorityFromAgentsService } from './agent-run-projection-authority-client'

describe('agent-run-projection-authority-client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetches projection authority claims through the Agents service boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        schemaVersion: 'v1',
        generatedAt: '2026-05-20T12:00:00.000Z',
        total: 1,
        claims: [
          {
            claim_id: 'projection-claim:agentrun_execution:1',
            claim_class: 'agentrun_execution',
            source_ref: 'agent_runs:1',
            source_owner: 'codex-worker',
            lane: 'codex-worker',
            status: 'running',
            observed_at: '2026-05-20T12:00:00.000Z',
            last_heartbeat_at: '2026-05-20T12:00:00.000Z',
            fresh_until: '2026-05-20T18:00:00.000Z',
            live_authority_ref: 'agents-service-agentrun:run-1',
            projection_ref: 'agent_runs:1',
            authority_state: 'authoritative',
            reason_codes: ['agents_service_agentrun_projection_current'],
            value_gates: ['failed_agentrun_rate'],
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAgentRunProjectionAuthorityFromAgentsService(
      {
        agentName: ' codex-worker ',
        limit: 12.8,
        includeTerminalAudit: true,
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test/',
        AGENTS_SERVICE_CLIENT_NAME: 'projection-authority-test',
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      'http://agents.test/v1/agent-runs/projection-authority?agentName=codex-worker&limit=12&includeTerminalAudit=true',
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-agents-client': 'projection-authority-test',
      },
    })
  })

  it('omits blank and non-positive query params while preserving explicit false audit inclusion', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        schemaVersion: 'v1',
        generatedAt: '2026-05-20T12:00:00.000Z',
        total: 0,
        claims: [],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await fetchAgentRunProjectionAuthorityFromAgentsService(
      {
        agentName: '   ',
        limit: 0,
        includeTerminalAudit: false,
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test',
        AGENTS_SERVICE_CLIENT_NAME: 'projection-authority-test',
      },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      'http://agents.test/v1/agent-runs/projection-authority?includeTerminalAudit=false',
    )
  })
})
