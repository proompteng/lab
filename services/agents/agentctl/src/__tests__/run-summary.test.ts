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
})
