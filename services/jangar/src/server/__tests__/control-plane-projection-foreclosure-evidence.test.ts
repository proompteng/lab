import { beforeEach, describe, expect, it, vi } from 'vitest'

const projectionAuthorityClientMocks = vi.hoisted(() => ({
  fetchAgentRunProjectionAuthorityFromAgentsService: vi.fn(),
}))

vi.mock('@proompteng/agent-contracts/agent-run-projection-authority-client', () => projectionAuthorityClientMocks)

vi.mock('~/server/db', () => ({
  getDb: () => null,
}))

describe('collectProjectionForeclosureEvidence', () => {
  beforeEach(() => {
    projectionAuthorityClientMocks.fetchAgentRunProjectionAuthorityFromAgentsService.mockReset()
  })

  it('collects AgentRun projection authority through the Agents-owned client', async () => {
    const claims = [
      {
        claim_id: 'projection-claim:agentrun_execution:live',
        claim_class: 'agentrun_execution',
        source_ref: 'agentrun/jangar-control-plane-implement-live',
        source_owner: 'jangar-control-plane-implement',
        lane: 'implement',
        status: 'Running',
        observed_at: '2026-05-20T11:00:00.000Z',
        last_heartbeat_at: '2026-05-20T11:59:00.000Z',
        fresh_until: '2026-05-20T12:30:00.000Z',
        live_authority_ref: 'jangar-control-plane-implement-live',
        projection_ref: 'agent_runs:00000000-0000-0000-0000-000000000001',
        authority_state: 'authoritative',
        reason_codes: ['agents_service_agentrun_projection_current'],
        value_gates: ['ready_status_truth'],
      },
      {
        claim_id: 'projection-claim:agentrun_execution:terminal',
        claim_class: 'agentrun_execution',
        source_ref: 'agentrun/jangar-control-plane-terminal',
        source_owner: 'jangar-control-plane-terminal',
        lane: 'implement',
        status: 'completed',
        observed_at: '2026-05-20T10:00:00.000Z',
        last_heartbeat_at: '2026-05-20T10:00:00.000Z',
        fresh_until: null,
        live_authority_ref: 'jangar-control-plane-terminal',
        projection_ref: 'agent_runs:00000000-0000-0000-0000-000000000002',
        authority_state: 'terminal_audit',
        reason_codes: ['agents_service_agentrun_projection_terminal_audit'],
        value_gates: ['handoff_evidence_quality'],
      },
    ]
    projectionAuthorityClientMocks.fetchAgentRunProjectionAuthorityFromAgentsService.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        ok: true,
        schemaVersion: 'agents.agentrun-projection-authority.v1',
        generatedAt: '2026-05-20T12:00:00.000Z',
        total: 2,
        claims,
      },
    })

    const { collectProjectionForeclosureEvidence } =
      await import('~/server/control-plane-projection-foreclosure-evidence')
    const evidence = await collectProjectionForeclosureEvidence()

    expect(projectionAuthorityClientMocks.fetchAgentRunProjectionAuthorityFromAgentsService).toHaveBeenCalledWith({
      limit: 100,
      includeTerminalAudit: true,
    })
    expect(evidence.agentRunProjections).toEqual(claims)
    expect(evidence.collectionErrors).toEqual([])
  })

  it('surfaces projection authority collection failures without querying raw AgentRuns', async () => {
    projectionAuthorityClientMocks.fetchAgentRunProjectionAuthorityFromAgentsService.mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: null,
      error: 'projection authority unavailable',
    })

    const { collectProjectionForeclosureEvidence } =
      await import('~/server/control-plane-projection-foreclosure-evidence')
    const evidence = await collectProjectionForeclosureEvidence()

    expect(evidence.agentRunProjections).toEqual([])
    expect(evidence.collectionErrors).toEqual([
      'Agents service agent_run projection authority collection failed: projection authority unavailable',
    ])
  })
})
