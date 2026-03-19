import { describe, expect, test } from 'bun:test'

import { buildGenerationCaptureProperties, buildSpanCaptureProperties, buildTraceCaptureProperties } from './posthog'

describe('posthog llm analytics property mapping', () => {
  test('maps generation errors to documented ai error fields', () => {
    const properties = buildGenerationCaptureProperties({
      traceId: 'trace-1',
      sessionId: 'session-1',
      spanId: 'span-1',
      spanName: 'codex_turn',
      parentId: 'root-1',
      model: 'gpt-5-mini',
      provider: 'openai',
      input: [{ role: 'user', content: 'hello' }],
      outputChoices: [{ role: 'assistant', content: 'hi' }],
      inputTokens: 5,
      outputTokens: 3,
      latencySeconds: 1.2,
      timeToFirstTokenSeconds: 0.2,
      stream: true,
      error: { message: 'boom', code: 'FAIL', api_key: 'secret' },
      properties: {
        issue_id: 'issue-1',
      },
    })

    expect(properties.$process_person_profile).toBe(false)
    expect(properties.$ai_span_name).toBe('codex_turn')
    expect(properties.$ai_is_error).toBe(true)
    expect(properties.$ai_error).toEqual({
      message: 'boom',
      code: 'FAIL',
    })
    expect('error' in properties).toBe(false)
  })

  test('preserves documented ai token metrics while removing secret-like keys', () => {
    const properties = buildGenerationCaptureProperties({
      traceId: 'trace-1',
      sessionId: 'session-1',
      spanId: 'span-1',
      spanName: 'codex_turn',
      model: 'gpt-5-mini',
      provider: 'openai',
      input: [{ role: 'user', content: 'hello' }],
      outputChoices: [{ role: 'assistant', content: 'hi' }],
      inputTokens: 5,
      outputTokens: 3,
      timeToFirstTokenSeconds: 0.2,
      properties: {
        sessionToken: 'drop-me',
      },
    })

    expect(properties.$ai_input_tokens).toBe(5)
    expect(properties.$ai_output_tokens).toBe(3)
    expect(properties.$ai_time_to_first_token).toBe(0.2)
    expect('sessionToken' in properties).toBe(false)
  })

  test('maps span errors to documented ai error fields', () => {
    const properties = buildSpanCaptureProperties({
      traceId: 'trace-1',
      sessionId: 'session-1',
      spanId: 'span-1',
      parentId: 'root-1',
      spanName: 'tool_call',
      inputState: { query: 'status' },
      outputState: { result: 'ok' },
      latencySeconds: 0.4,
      error: 'timeout',
      properties: {
        issue_identifier: 'ABC-1',
      },
    })

    expect(properties.$ai_trace_id).toBe('trace-1')
    expect(properties.$ai_span_name).toBe('tool_call')
    expect(properties.$ai_is_error).toBe(true)
    expect(properties.$ai_error).toBe('timeout')
    expect('error' in properties).toBe(false)
  })

  test('keeps trace properties in documented fields', () => {
    const properties = buildTraceCaptureProperties({
      traceId: 'trace-1',
      sessionId: 'session-1',
      spanName: 'symphony_issue_run',
      inputState: { issue_id: 'issue-1' },
      outputState: { status: 'done' },
      latencySeconds: 3.5,
      error: null,
      properties: {
        service: 'symphony',
        authToken: 'redacted',
      },
    })

    expect(properties.$ai_trace_id).toBe('trace-1')
    expect(properties.$ai_session_id).toBe('session-1')
    expect(properties.$ai_span_name).toBe('symphony_issue_run')
    expect(properties.$ai_input_state).toEqual({ issue_id: 'issue-1' })
    expect(properties.$ai_output_state).toEqual({ status: 'done' })
    expect(properties.$ai_latency).toBe(3.5)
    expect(properties.service).toBe('symphony')
    expect('authToken' in properties).toBe(false)
    expect('$ai_is_error' in properties).toBe(false)
    expect('$ai_error' in properties).toBe(false)
  })
})
