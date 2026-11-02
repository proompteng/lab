import { describe, expect, test } from 'vitest'
import {
  approveAction,
  buildSnapshot,
  createGatewayState,
  createRuleFromText,
  createTaskFromText,
  evaluateAgentRun,
  exportAuditEvents,
} from './gateway'

describe('secure action gateway engine', () => {
  test('translates natural language into an active rule', () => {
    const state = createGatewayState()
    const rule = createRuleFromText(state, {
      actorId: 'greg',
      text: 'Block AgentRuns that request production auth tokens',
    })

    expect(rule.mode).toBe('block')
    expect(rule.target).toBe('secret')
    expect(buildSnapshot(state).rules[0]?.id).toBe(rule.id)
    expect(buildSnapshot(state).events[0]?.operation).toBe('rule:create')
  })

  test('executes a natural-language task through real connector primitives', () => {
    const state = createGatewayState()
    const task = createTaskFromText(
      state,
      {
        actorId: 'greg',
        text: 'Inspect live agent runs, read SQL policy state, query audit graph, and parse the legacy feed',
      },
      {
        database: {
          source: 'postgres',
          tasks: 2,
          auditEvents: 10,
          approvals: 0,
          policies: 2,
          connectorCalls: 4,
        },
        liveAgentRuns: [
          {
            actorId: 'greg',
            name: 'live-run',
            namespace: 'agents',
            agent: 'codex',
            requestedSecrets: [],
            requestedConnectors: ['kubernetes'],
            requestedTools: ['runtime:job'],
          },
        ],
      },
    )
    const snapshot = buildSnapshot(state)

    expect(task.status).toBe('succeeded')
    expect(snapshot.connectorCalls.map((call) => call.connector)).toEqual(
      expect.arrayContaining(['sql', 'rest', 'graphql', 'legacy']),
    )
    expect(snapshot.events.some((event) => event.operation === 'task:intake')).toBe(true)
  })

  test('requires approval for mutating natural-language actions', () => {
    const state = createGatewayState()
    const task = createTaskFromText(state, {
      actorId: 'greg',
      text: 'Inspect AgentRuns and execute a guarded restart if policy allows it',
    })
    const approval = buildSnapshot(state).approvals[0]

    expect(task.status).toBe('waiting_approval')
    expect(approval?.status).toBe('pending')

    const rejected = approveAction(state, { actorId: 'audit', approvalId: approval.id })
    expect(rejected.ok).toBe(false)
    expect(buildSnapshot(state).approvals[0]?.status).toBe('pending')

    const approved = approveAction(state, { actorId: 'ops', approvalId: approval.id })
    expect(approved.ok).toBe(true)
    expect(buildSnapshot(state).tasks.find((item) => item.id === task.id)?.decision).toBe('approved')
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
})
