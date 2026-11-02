import { describe, expect, test } from 'bun:test'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import { automaticApprovalDecision } from './approval-mode'

const event: TengriCodexEvent = {
  sequence: 1,
  kind: 'approval',
  method: 'item/commandExecution/requestApproval',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: '',
  approvalId: '1',
  text: '',
  rawJson: '{}',
}

describe('automatic approval', () => {
  test('uses only advertised action decisions', () => {
    expect(
      automaticApprovalDecision({
        ...event,
        rawJson: JSON.stringify({ params: { availableDecisions: ['accept', 'acceptForSession', 'decline'] } }),
      }),
    ).toBe('approve-once')
    expect(
      automaticApprovalDecision({ ...event, rawJson: JSON.stringify({ params: { availableDecisions: ['decline'] } }) }),
    ).toBeUndefined()
    expect(
      automaticApprovalDecision({
        ...event,
        method: 'mcpServer/elicitation/request',
        rawJson: JSON.stringify({
          params: {
            mode: 'form',
            requestedSchema: { properties: {} },
            _meta: { codex_approval_kind: 'mcp_tool_call' },
          },
        }),
      }),
    ).toBe('approve-once')
  })
  test('never answers native questions, input forms, URL elicitations or unknown requests', () => {
    expect(automaticApprovalDecision({ ...event, method: 'item/tool/requestUserInput' })).toBeUndefined()
    for (const params of [
      { mode: 'form', requestedSchema: { type: 'object', properties: {} } },
      { mode: 'form', requestedSchema: { properties: { name: { type: 'string' } } } },
      { mode: 'url', url: 'https://example.test', _meta: { codex_approval_kind: 'mcp_tool_call' } },
      {
        mode: 'form',
        requestedSchema: { properties: { name: { type: 'string' } } },
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      },
    ])
      expect(
        automaticApprovalDecision({
          ...event,
          method: 'mcpServer/elicitation/request',
          rawJson: JSON.stringify({ params }),
        }),
      ).toBeUndefined()
    expect(automaticApprovalDecision({ ...event, method: 'unknown/request' })).toBeUndefined()
  })
})
