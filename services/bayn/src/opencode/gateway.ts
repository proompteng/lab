import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { ResearchError } from '../research-inference/contract'
import { strictParseOptions } from '../schemas'
import { maximumOpenCodeInputBytes, openCodeConfiguration, openCodeModel } from './configuration'

const NativeRequestSchema = Schema.Struct({
  model: Schema.Literal(openCodeModel),
  stream: Schema.Literal(true),
  stream_options: Schema.Struct({ include_usage: Schema.Literal(true) }),
  max_completion_tokens: Schema.Literal(4096),
  temperature: Schema.Literal(0.6),
  tool_choice: Schema.Literal('none'),
  reasoning_effort: Schema.Literal('low'),
  response_format: Schema.Unknown,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(['system', 'developer', 'user', 'assistant', 'tool']),
      content: Schema.Unknown,
      reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
      tool_calls: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      tool_call_id: Schema.optionalKey(Schema.String),
    }),
  ).check(Schema.isMinLength(1)),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal('function'),
        function: Schema.Struct({
          name: Schema.Literal('read'),
          description: Schema.optionalKey(Schema.String),
          parameters: Schema.Unknown,
          strict: Schema.optionalKey(Schema.Boolean),
        }),
      }),
    ),
  ),
})

export interface OpenCodeAttempt {
  readonly sessionId: string
  readonly deadlineAtMs: number
  calls: number
}

export const admitOpenCodeCall = (
  attempt: OpenCodeAttempt | undefined,
  request: { readonly body: string; readonly sessionId: string | undefined },
  nowMs: number,
) =>
  Result.gen(function* () {
    if (
      attempt === undefined ||
      attempt.calls !== 0 ||
      nowMs >= attempt.deadlineAtMs ||
      request.sessionId !== attempt.sessionId ||
      Buffer.byteLength(request.body) > maximumOpenCodeInputBytes
    )
      return yield* Result.fail(new ResearchError({ message: 'OpenCode call has no remaining registered budget' }))
    const body = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(NativeRequestSchema),
      strictParseOptions,
    )(request.body).pipe(
      Result.mapError((cause) => new ResearchError({ message: 'OpenCode call differs from its frozen policy', cause })),
    )
    if (
      (yield* canonicalHashV1Result(body.response_format)) !==
      (yield* canonicalHashV1Result(openCodeConfiguration.providers.opencode.body.response_format))
    )
      return yield* Result.fail(
        new ResearchError({ message: 'OpenCode response schema differs from the native contract' }),
      )
    attempt.calls += 1
    return body
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof ResearchError
        ? cause
        : new ResearchError({ message: 'OpenCode provider admission denied', cause }),
    ),
  )

export const nativeProviderHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      (name === 'authorization' ||
        name === 'user-agent' ||
        name.startsWith('x-opencode-') ||
        name === 'x-session-affinity' ||
        name === 'x-session-id' ||
        name === 'x-parent-session-id')
    )
      forwarded[name] = value
  }
  return forwarded
}
