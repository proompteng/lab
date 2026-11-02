import { describe, expect, test } from 'bun:test'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import { codexInputResponseSchema } from '@/lib/tengri/codex-input'
import { codexQuestionRequest, codexQuestionResponse } from './codex-question-model'
const event: TengriCodexEvent = {
  sequence: 1,
  kind: 'approval',
  method: 'item/tool/requestUserInput',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: '',
  approvalId: '1',
  text: '',
  rawJson: '{}',
}

describe('agent questions', () => {
  test('preserves question IDs, advertised choices and free-text answers', () => {
    const request = codexQuestionRequest({
      ...event,
      rawJson: JSON.stringify({
        params: {
          questions: [
            {
              id: 'environment',
              header: 'Target',
              question: 'Which environment?',
              isOther: true,
              options: [{ label: 'Staging', description: 'Preview' }],
            },
            { id: 'notes', question: 'Any notes?', isSecret: true },
          ],
        },
      }),
    })!
    expect(request.fields[0].choices[0].label).toBe('Staging')
    expect(request.fields[1].secret).toBe(true)
    expect(codexQuestionResponse(request, { q0: 'Staging', q1: 'Keep the old files' })).toEqual({
      answers: { environment: { answers: ['Staging'] }, notes: { answers: ['Keep the old files'] } },
    })
  })
  test('keeps typed MCP forms and URL completion separate from action approvals', () => {
    const form = codexQuestionRequest({
      ...event,
      method: 'mcpServer/elicitation/request',
      rawJson: JSON.stringify({
        params: {
          mode: 'form',
          message: 'Settings',
          requestedSchema: {
            type: 'object',
            properties: { count: { type: 'integer' }, enabled: { type: 'boolean' } },
            required: ['count', 'enabled'],
          },
        },
      }),
    })!
    expect(codexQuestionResponse(form, { q0: '3', q1: 'false' })).toEqual({
      action: 'accept',
      content: { count: 3, enabled: false },
    })
    expect(
      codexQuestionRequest({
        ...event,
        method: 'mcpServer/elicitation/request',
        rawJson: JSON.stringify({ params: { mode: 'url', url: 'javascript:alert(1)' } }),
      }),
    ).toBeNull()
    expect(codexInputResponseSchema.safeParse({ answers: {} }).success).toBe(true)
    expect(codexInputResponseSchema.safeParse({ answers: { x: { answers: ['a', 'b'] } } }).success).toBe(false)
  })
})
