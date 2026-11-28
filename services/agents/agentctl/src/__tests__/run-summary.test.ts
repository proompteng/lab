import { describe, expect, it } from 'bun:test'
import { parseRunLogs } from '../cli/run-summary'

const jsonl = (...events: Record<string, unknown>[]) => events.map((event) => JSON.stringify({ event })).join('\n')

describe('runner log summary', () => {
  it('reconstructs the final response using the terminal preview and the latest cumulative token usage', () => {
    const usage = { inputTokens: 120, cachedInputTokens: 90, outputTokens: 40, reasoningOutputTokens: 8 }
    const logs = jsonl(
      { type: 'heartbeat', telemetry: { model: 'gpt-test', effort: 'high', startedAt: '2026-11-28T01:00:00Z' } },
      { type: 'usage', usage: { ...usage, inputTokens: 100 } },
      { type: 'turn_started' },
      { type: 'message', delta: 'I will inspect the diff first.' },
      { type: 'tool', id: 'cmd', status: 'started' },
      { type: 'output', id: 'cmd', delta: 'https://github.com/Owner/Repo/pu' },
      { type: 'output', id: 'another', delta: 'unprinted tool data' },
      { type: 'output', id: 'cmd', delta: 'll/42?access_token=private-query\n' },
      { type: 'tool', id: 'cmd', status: 'completed' },
      { type: 'reasoning', delta: 'unprinted reasoning' },
      { type: 'message', delta: 'Implemented and ' },
      {
        type: 'message',
        delta: 'tested.\n- https://github.com/owner/repo/pull/42#checks\n- https://github.com/owner/repo/pull/',
      },
      { type: 'message', delta: '43' },
      { type: 'usage', usage },
      { type: 'heartbeat', telemetry: { model: 'gpt-test', effort: 'high', usage } },
      {
        type: 'runner_terminal_status',
        status: { status: 'succeeded', result: { text: 'Implemented and tested.', truncated: true } },
      },
    )
    const result = parseRunLogs(`startup noise\n${logs}\n{"event":{"type":`)
    expect(result).toMatchObject({
      model: 'gpt-test',
      effort: 'high',
      usage: { input: 120, cached: 90, output: 40, reasoning: 8 },
      prUrls: ['https://github.com/owner/repo/pull/42', 'https://github.com/owner/repo/pull/43'],
      assistantMessage:
        'Implemented and tested.\n- https://github.com/owner/repo/pull/42\n- https://github.com/owner/repo/pull/43',
      assistantMessageComplete: true,
    })
  })

  it('recovers a long final response following tool-free commentary', () => {
    const final = `Implementation complete. ${'The workflow and binary checks passed. '.repeat(8)}Done.`
    const logs = jsonl(
      { type: 'turn_started' },
      { type: 'message', delta: 'I will check the workflow and report back.' },
      { type: 'message', delta: final.slice(0, 100) },
      { type: 'message', delta: final.slice(100) },
      {
        type: 'runner_terminal_status',
        status: { status: 'succeeded', result: { text: final.slice(0, 256), truncated: true } },
      },
    )
    expect(parseRunLogs(logs)).toMatchObject({
      assistantMessage: final,
      assistantMessageComplete: true,
    })
  })

  it('keeps a preview partial when it matches more than one point in the stream', () => {
    const preview = 'The following is the final response. '.repeat(7).slice(0, 256)
    const logs = jsonl(
      { type: 'message', delta: `The expected response is: ${preview}\n` },
      { type: 'message', delta: `${preview}Done.` },
    )
    const status = { status: 'succeeded', result: { text: preview, truncated: true } }
    expect(parseRunLogs(logs, status)).toMatchObject({
      assistantMessage: preview.trim(),
      assistantMessageComplete: false,
    })
  })

  it('uses the terminal result when it disagrees with deltas or logs have rotated', () => {
    const logs = jsonl(
      { type: 'turn_started' },
      { type: 'message', delta: 'A prior turn.' },
      { type: 'turn_started' },
      { type: 'message', delta: 'Only the tail of the new turn survived.' },
    )
    const status = { status: 'succeeded', result: { text: 'Actual result', truncated: false } }
    expect(parseRunLogs(logs, status)).toMatchObject({
      assistantMessage: 'Actual result',
      assistantMessageComplete: true,
    })
    expect(parseRunLogs(logs)).toMatchObject({
      assistantMessage: 'Only the tail of the new turn survived.',
      assistantMessageComplete: false,
      usage: null,
    })
    expect(parseRunLogs(logs, { ...status, result: { ...status.result, truncated: true } })).toMatchObject({
      assistantMessage: 'Actual result',
      assistantMessageComplete: false,
    })
  })

  it('redacts credentials after joining deltas and never includes raw tool or error text', () => {
    const logs = jsonl(
      { type: 'tool', output: 'opaque-tool-credential https://github.com/owner/repo/pull/5?token=tool-query' },
      { type: 'error', message: 'opaque-error-credential' },
      { type: 'message', delta: 'Done. ghp_' },
      {
        type: 'message',
        delta:
          'fixture-secret\nAuthorization: Bearer auth-secret\n"API_KEY": "quoted\\"secret"\nhttps://x:url-pass@example.com\nhttps://example.com?sig=url-signature\n',
      },
      {
        type: 'message',
        delta:
          '-----BEGIN PRIVATE KEY-----\nkey-contents\n-----END PRIVATE KEY-----\nopaque-known-token\n\u001b]8;;unsafe-target\u001b\\text\u001b]8;;\u001b\\',
      },
    )
    const result = parseRunLogs(logs, undefined, 'opaque-known-token')
    const output = JSON.stringify(result)
    for (const secret of [
      'fixture-secret',
      'auth-secret',
      'quoted',
      'url-pass',
      'url-signature',
      'key-contents',
      'tool-query',
      'opaque-tool-credential',
      'opaque-error-credential',
      'opaque-known-token',
      'unsafe-target',
    ]) {
      expect(output).not.toContain(secret)
    }
    expect(result.assistantMessage).toContain('Done. [redacted token]')
    expect(result.prUrls).toEqual(['https://github.com/owner/repo/pull/5'])
  })

  it('parses agy-cli runner telemetry logs and status.json without blank fields', () => {
    const commentary = 'Inspecting repository files before editing.'
    const finalBody = `Implemented Google run dispatch. ${'All agentctl unit checks passed. '.repeat(8)}Opened https://github.com/proompteng/lab/pull/401.`
    const combined = `${commentary}${finalBody}`
    const usage = {
      inputTokens: 1200,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 0,
      outputTokens: 150,
      reasoningOutputTokens: 30,
      totalTokens: 1350,
    }
    const logs = [
      JSON.stringify({
        ts: '2026-11-28T10:00:00Z',
        event: {
          type: 'heartbeat',
          telemetry: {
            version: 1,
            state: 'starting',
            startedAt: '2026-11-28T10:00:00Z',
            heartbeatAt: '2026-11-28T10:00:00Z',
            model: 'gemini-4-neon',
            effort: 'high',
          },
        },
      }),
      JSON.stringify({
        ts: '2026-11-28T10:00:01Z',
        event: { type: 'turn_started', threadId: 'conv-1', turnId: 'turn-1' },
      }),
      JSON.stringify({ ts: '2026-11-28T10:00:02Z', event: { type: 'message', delta: commentary, truncated: false } }),
      JSON.stringify({
        ts: '2026-11-28T10:00:03Z',
        event: { type: 'tool', id: 'step-1', kind: 'commandExecution', title: 'gh pr create', status: 'started' },
      }),
      JSON.stringify({
        ts: '2026-11-28T10:00:04Z',
        event: {
          type: 'tool',
          id: 'step-1',
          kind: 'commandExecution',
          title: 'gh pr create',
          status: 'completed',
          output: 'https://github.com/proompteng/lab/pull/401\n',
        },
      }),
      JSON.stringify({ ts: '2026-11-28T10:00:05Z', event: { type: 'message', delta: finalBody, truncated: false } }),
      JSON.stringify({ ts: '2026-11-28T10:00:06Z', event: { type: 'usage', usage } }),
      JSON.stringify({
        ts: '2026-11-28T10:00:07Z',
        event: { type: 'turn_completed', threadId: 'conv-1', turnId: 'turn-1', status: 'completed' },
      }),
    ].join('\n')

    const agyStatus = {
      provider: 'google',
      adapter: 'agy-cli',
      binary: '/usr/local/bin/agy',
      exitCode: 0,
      status: 'succeeded',
      startedAt: '2026-11-28T10:00:00Z',
      finishedAt: '2026-11-28T10:00:12Z',
      threadId: 'conv-1',
      model: 'gemini-4-neon',
      effort: 'high',
      result: { text: combined.slice(0, 256), truncated: true },
      telemetry: {
        version: 1,
        state: 'finished',
        startedAt: '2026-11-28T10:00:00Z',
        heartbeatAt: '2026-11-28T10:00:12Z',
        model: 'gemini-4-neon',
        effort: 'high',
        usage,
      },
    }

    const result = parseRunLogs(logs, agyStatus)
    expect(result).toMatchObject({
      startedAt: '2026-11-28T10:00:00Z',
      finishedAt: '2026-11-28T10:00:12Z',
      model: 'gemini-4-neon',
      effort: 'high',
      usage: { input: 1200, cached: 400, output: 150, reasoning: 30 },
      prUrls: ['https://github.com/proompteng/lab/pull/401'],
      assistantMessage: combined,
      assistantMessageComplete: true,
    })
  })

  it('parses raw agy-cli stream-json NDJSON events and result.json output', () => {
    const rawAgyLogs = [
      JSON.stringify({
        event: 'init',
        conversation_id: 'conv-neon-1',
        init: { cwd: '/workspace/lab', tools: ['run_command'], model: 'gemini-4-neon', effort: 'high' },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-neon-1',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'gh pr create' } },
        },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-neon-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          duration_seconds: 0.4,
          tool_info: {
            name: 'run_command',
            output: 'Created PR https://github.com/proompteng/lab/pull/512?token=secret-query\n',
          },
        },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-neon-1',
          step_index: 2,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'Completed fix in https://github.com/proompteng/lab/pull/512.',
          usage: {
            input_tokens: 320,
            cache_read_tokens: 80,
            output_tokens: 45,
            thinking_tokens: 12,
            total_tokens: 365,
          },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-neon-1',
          status: 'SUCCESS',
          response: 'Completed fix in https://github.com/proompteng/lab/pull/512.',
          duration_seconds: 4.25,
          num_turns: 1,
          usage: {
            input_tokens: 320,
            cache_read_tokens: 80,
            output_tokens: 45,
            thinking_tokens: 12,
            total_tokens: 365,
          },
        },
      }),
    ].join('\n')

    const parsed = parseRunLogs(rawAgyLogs)
    expect(parsed).toMatchObject({
      events: 5,
      durationMs: 4250,
      model: 'gemini-4-neon',
      effort: 'high',
      usage: { input: 320, cached: 80, output: 45, reasoning: 12 },
      prUrls: ['https://github.com/proompteng/lab/pull/512'],
      assistantMessage: 'Completed fix in https://github.com/proompteng/lab/pull/512.',
      assistantMessageComplete: true,
    })

    const resultJson = {
      schemaVersion: 'agents.proompteng.ai/result/v1',
      threadId: 'conv-neon-1',
      responseText: 'Full response from result.json with https://github.com/proompteng/lab/pull/513.',
      responseTruncated: false,
    }
    const fromResultFile = parseRunLogs('', resultJson)
    expect(fromResultFile).toMatchObject({
      prUrls: ['https://github.com/proompteng/lab/pull/513'],
      assistantMessage: 'Full response from result.json with https://github.com/proompteng/lab/pull/513.',
      assistantMessageComplete: true,
    })
  })

  it('handles failed agy-cli runs safely without throwing or leaking error payloads', () => {
    const failedStatus = {
      provider: 'google',
      adapter: 'agy-cli',
      exitCode: 1,
      status: 'failed',
      startedAt: '2026-11-28T10:00:00Z',
      finishedAt: '2026-11-28T10:00:05Z',
      model: 'gemini-4-neon',
      error: 'permission denied with opaque-adc-error',
    }
    const result = parseRunLogs(
      JSON.stringify({
        ts: '2026-11-28T10:00:05Z',
        component: 'agy-cli',
        event: { type: 'stderr', line: 'opaque-stderr-secret' },
      }),
      failedStatus,
    )
    expect(result).toMatchObject({
      startedAt: '2026-11-28T10:00:00Z',
      finishedAt: '2026-11-28T10:00:05Z',
      model: 'gemini-4-neon',
      effort: null,
      usage: null,
      prUrls: [],
      assistantMessage: null,
      assistantMessageComplete: false,
    })
    expect(JSON.stringify(result)).not.toContain('opaque-adc-error')
    expect(JSON.stringify(result)).not.toContain('opaque-stderr-secret')
  })

  it('recovers a complete agy-cli result.response when status.result.text is truncated and deltas rotated out', () => {
    const fullResponse = `${'A'.repeat(300)} https://github.com/proompteng/lab/pull/514`
    const logs = JSON.stringify({
      ts: '2026-11-28T10:00:04Z',
      event: 'result',
      result: {
        model: 'gemini-4-neon',
        effort: 'high',
        response: fullResponse,
      },
    })
    const status = {
      provider: 'google',
      adapter: 'agy-cli',
      status: 'succeeded',
      result: {
        text: 'A'.repeat(256),
        truncated: true,
      },
    }

    const parsed = parseRunLogs(logs, status)
    expect(parsed.assistantMessage).toBe(fullResponse)
    expect(parsed.assistantMessageComplete).toBe(true)
    expect(parsed.prUrls).toEqual(['https://github.com/proompteng/lab/pull/514'])
  })

  it('reconstructs cumulative agy-cli responses across tool calls even when the preview fits inside the first chunk', () => {
    const firstChunk = Array.from(
      { length: 10 },
      (_, idx) => `Step ${idx + 1} commentary before invoking the tool. `,
    ).join('')
    const finalChunk = 'Final answer after tool call with https://github.com/proompteng/lab/pull/515.'
    const logs = [
      JSON.stringify({
        ts: '2026-11-28T10:00:01Z',
        event: { type: 'message', delta: firstChunk, truncated: false },
      }),
      JSON.stringify({
        ts: '2026-11-28T10:00:02Z',
        event: { type: 'tool', kind: 'commandExecution', status: 'started' },
      }),
      JSON.stringify({
        ts: '2026-11-28T10:00:03Z',
        event: { type: 'message', delta: finalChunk, truncated: false },
      }),
    ].join('\n')
    const status = {
      provider: 'google',
      adapter: 'agy-cli',
      status: 'succeeded',
      result: {
        text: firstChunk.slice(0, 256),
        truncated: true,
      },
    }

    const parsed = parseRunLogs(logs, status)
    expect(parsed.assistantMessage).toBe(`${firstChunk}${finalChunk}`)
    expect(parsed.assistantMessageComplete).toBe(true)
    expect(parsed.prUrls).toEqual(['https://github.com/proompteng/lab/pull/515'])
  })
})
