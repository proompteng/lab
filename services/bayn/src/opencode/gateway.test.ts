import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { admitOpenCodeCall, nativeProviderHeaders, type OpenCodeAttempt } from './gateway'
import { openCodeConfiguration, openCodeModel } from './configuration'

const request = (change: object = {}) => ({
  sessionId: 'ses_study',
  body: JSON.stringify({
    model: openCodeModel,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 4096,
    temperature: 0.6,
    tool_choice: 'none',
    reasoning_effort: 'low',
    response_format: openCodeConfiguration.providers.opencode.body.response_format,
    messages: [{ role: 'user', content: 'Native Jev feedback' }],
    tools: [],
    ...change,
  }),
})
const attempt = (): OpenCodeAttempt => ({ sessionId: 'ses_study', deadlineAtMs: 1000, calls: 0 })

test('only one native request can consume a registered attempt', () => {
  const state = attempt()
  expect(Result.isSuccess(admitOpenCodeCall(state, request(), 1))).toBe(true)
  expect(Result.isFailure(admitOpenCodeCall(state, request(), 2))).toBe(true)
  expect(state.calls).toBe(1)
})

test('inactive, expired and other-study calls cannot reach the hosted provider', () => {
  expect(Result.isFailure(admitOpenCodeCall(undefined, request(), 1))).toBe(true)
  expect(Result.isFailure(admitOpenCodeCall(attempt(), request(), 1000))).toBe(true)
  expect(Result.isFailure(admitOpenCodeCall(attempt(), { ...request(), sessionId: 'ses_other' }, 1))).toBe(true)
})

test('paid models, extra output, altered schema and oversized input are denied before consuming budget', () => {
  for (const changed of [
    { model: 'gpt-5' },
    { max_completion_tokens: 8192 },
    { max_tokens: 100000 },
    { tool_choice: 'auto' },
    { reasoning_effort: 'max' },
    { response_format: { type: 'text' } },
    { messages: [{ role: 'user', content: 'x'.repeat(32768) }] },
  ]) {
    const state = attempt()
    expect(Result.isFailure(admitOpenCodeCall(state, request(changed), 1))).toBe(true)
    expect(state.calls).toBe(0)
  }
})

test('the relay preserves actual native routing metadata without forwarding hop-by-hop or local-only headers', () => {
  const native = {
    'user-agent': 'opencode/latest/2.1.3/cli',
    'x-opencode-client': 'cli',
    'x-opencode-session-id': 'ses_study',
    'x-opencode-session': 'session-affinity',
    'x-session-affinity': 'session-affinity',
    'x-session-id': 'session-affinity',
    'x-opencode-project': 'project',
  }
  expect(
    nativeProviderHeaders({
      ...native,
      host: '127.0.0.1:4098',
      connection: 'keep-alive',
      'content-length': '123',
      'proxy-authorization': 'local-only',
    }),
  ).toEqual(native)
})
