import { describe, expect, test } from 'bun:test'

import { validateChatSmokeResponse } from './benchmark-flamingo-vllm'

function textResponse(content: string, finishReason = 'stop', completionTokens = 8): unknown {
  return {
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { completion_tokens: completionTokens },
  }
}

describe('validateChatSmokeResponse', () => {
  test('accepts real OpenAI text completion fields', () => {
    expect(validateChatSmokeResponse('exact-no-thinking', textResponse('qwen36-ready'))).toEqual([])
    expect(validateChatSmokeResponse('medium-thinking', textResponse('qwen36-thinking-ready'))).toEqual([])
  })

  test('reads finish_reason from the choice rather than the message', () => {
    const response = {
      choices: [{ finish_reason: 'content_filter', message: { content: 'qwen36-ready', finish_reason: 'stop' } }],
    }
    expect(validateChatSmokeResponse('exact-no-thinking', response)).toContain(
      'choices[0].finish_reason must be "stop" or "length", got "content_filter"',
    )
  })

  test('reads completion_tokens from top-level usage', () => {
    const response = {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'qwen36-thinking-ready', completion_tokens: 8 },
        },
      ],
      usage: { completion_tokens: 0 },
    }
    expect(validateChatSmokeResponse('medium-thinking', response)).toContain(
      'usage.completion_tokens must be positive, got 0',
    )
  })

  test('requires one exact structured tool call', () => {
    const response = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                type: 'function',
                function: { name: 'lookup_status', arguments: '{"id":"FLAMINGO-262K"}' },
              },
            ],
          },
        },
      ],
    }
    expect(validateChatSmokeResponse('tool-call', response)).toEqual([])

    const extraArgument = structuredClone(response)
    const toolCalls = (extraArgument.choices[0].message as { tool_calls: Array<{ function: { arguments: string } }> })
      .tool_calls
    toolCalls[0].function.arguments = '{"id":"FLAMINGO-262K","extra":true}'
    expect(validateChatSmokeResponse('tool-call', extraArgument)).toContain(
      'tool call arguments must be exactly {"id":"FLAMINGO-262K"}',
    )
  })

  test('validates dynamic long-context and prefix-cache markers', () => {
    expect(validateChatSmokeResponse('long-context-220000', textResponse('flamingo-long-220000'))).toEqual([])
    expect(validateChatSmokeResponse('prefix-cache-second', textResponse('prefix-cache-ready'))).toEqual([])
    expect(validateChatSmokeResponse('long-context-220000', textResponse('wrong marker'))).not.toEqual([])
  })

  test('does not impose a response contract on unrelated smoke labels', () => {
    expect(validateChatSmokeResponse('mtp-al-thinking-on', { choices: [] })).toEqual([])
  })
})
