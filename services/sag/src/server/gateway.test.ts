import { describe, expect, test } from 'vitest'
import {
  approveAction,
  buildSnapshot,
  createGatewayState,
  createRuleFromText,
  evaluateAgentRun,
  exportAuditEvents,
} from './gateway'

describe('secure action gateway engine', () => {
  test('translates natural language into an active AgentRun rule', () => {
    const state = createGatewayState()
    const rule = createRuleFromText(state, {
      actorId: 'greg',
      text: 'Block AgentRuns that request production auth tokens',
    })

    expect(rule.mode).toBe('block')
    expect(rule.target).toBe('agentrun.secret')
    expect(buildSnapshot(state).rules[0]?.id).toBe(rule.id)
    expect(buildSnapshot(state).events[0]?.operation).toBe('rule:create')
  })

  test('blocks sensitive AgentRun secret requests and redacts secret names', () => {
    const state = createGatewayState()
    const sensitiveSecret = 'production-auth-token'
    const agentRun = evaluateAgentRun(state, {
      actorId: 'greg',
      name: 'live-run',
      requestedSecrets: [sensitiveSecret],
      requestedConnectors: ['kubernetes'],
      requestedTools: ['runtime:workflow'],
      manifest: JSON.stringify({ spec: { secrets: [sensitiveSecret] } }, null, 2),
    })

    expect(agentRun.status).toBe('blocked')
    expect(agentRun.matchedRuleIds).toContain('rule-secret-boundary')
    expect(buildSnapshot(state).agentRuns[0]?.manifest).not.toContain(sensitiveSecret)
    expect(buildSnapshot(state).agentRuns[0]?.requestedSecrets[0]).toMatch(/^secret:/)
    expect(exportAuditEvents(state)).not.toContain(sensitiveSecret)
  })

  test('requires approval for mutating AgentRun actions', () => {
    const state = createGatewayState()
    const agentRun = evaluateAgentRun(state, {
      actorId: 'greg',
      name: 'write-run',
      requestedConnectors: ['kubernetes'],
      requestedTools: ['kubectl apply manifest'],
    })
    const approval = buildSnapshot(state).approvals[0]

    expect(agentRun.status).toBe('approval_required')
    expect(approval?.status).toBe('pending')

    const rejected = approveAction(state, { actorId: 'ops', approvalId: approval.id })
    expect(rejected.ok).toBe(false)
    expect(buildSnapshot(state).approvals[0]?.status).toBe('pending')

    const approved = approveAction(state, { actorId: 'greg', approvalId: approval.id })
    expect(approved.ok).toBe(true)
    expect(buildSnapshot(state).agentRuns.find((item) => item.id === agentRun.id)?.status).toBe('allowed')
  })
})
