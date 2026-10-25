import { Cause, Clock, Context, Data, Effect, Layer, Redacted, Result, Schema } from 'effect'
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/http'

import { canonicalHashV1Result, sha256 } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, type JevError, type JevInference } from './client'
import { JevFailure, JevResponseSchema, prepareJevRequest, type JevRequest } from './contract'
import { JevEntrySetup } from './trade-plan-choices'
import { nativeCandlestickEvidence } from './visual-evidence'

export const openAiDecisionsEndpoint = 'https://api.openai.com/v1/decisions' as const
export const openAiDecisionsModel = 'gpt-6-luna' as const
const Setup = Schema.Literals([JevEntrySetup.Upward, JevEntrySetup.Unclear, JevEntrySetup.Adverse])
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const DecisionResponse = Schema.Struct({
  model: Schema.Literal(openAiDecisionsModel),
  answers: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal('choice'),
        name: Schema.Literal('chart_setup'),
        choice: Setup,
        confidence: Probability,
        probabilities: Schema.Array(Schema.Struct({ value: Setup, probability: Probability })),
      }),
      Schema.Struct({ type: Schema.Literal('refusal'), name: Schema.NullOr(Schema.String) }),
    ]),
  ),
  usage: Schema.Struct({
    input_tokens: Tokens,
    input_tokens_details: Schema.Struct({ cached_tokens: Tokens, cache_write_tokens: Tokens }),
    output_tokens: Tokens,
    total_tokens: Tokens,
  }),
})

export class DualSignalError extends Data.TaggedError('DualSignalError')<{
  readonly message: string
  readonly category: 'INPUT' | 'PROVIDER' | 'CONTRACT' | 'DEADLINE'
  readonly cause?: unknown
  readonly diagnostic?: HttpClientError.HttpClientError['reason']['_tag'] | 'TimeoutError' | 'UnknownError'
}> {}

export interface VisualInference {
  readonly startedAt: string
  readonly completedAt: string
  readonly responseHash: string
  readonly response: typeof DecisionResponse.Type
}

export class VisualDecisionClient extends Context.Service<
  VisualDecisionClient,
  {
    readonly evaluate: (input: {
      readonly symbol: string
      readonly image: string
    }) => Effect.Effect<VisualInference, DualSignalError>
  }
>()('@proompteng/bayn/VisualDecisionClient') {}

export const visualDecisionRequest = (input: { readonly symbol: string; readonly image: string }) => ({
  model: openAiDecisionsModel,
  input: [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `Inspect completed one-minute OHLCV candles for ${input.symbol}. The lower histogram shows traded volume. This picture contains no data independent of the structured OHLCV.`,
        },
        { type: 'input_image', image_url: input.image },
      ],
    },
  ],
  questions: [
    {
      type: 'choice',
      name: 'chart_setup',
      instructions:
        'Classify only the observed candle and volume pattern in the newest bars. Do not predict profit, invent prices or use outside data. Upward requires current continuation and participation; adverse means current reversal, exhaustion or deterioration; unclear includes flat, mixed or unreadable evidence.',
      choices: [
        { value: JevEntrySetup.Upward, description: 'Current candles support upward continuation with participation.' },
        { value: JevEntrySetup.Unclear, description: 'Mixed, flat, insufficient or unreadable evidence.' },
        { value: JevEntrySetup.Adverse, description: 'Current candles show adverse deterioration or exhaustion.' },
      ],
    },
  ],
})

export const decodeVisualDecision = (input: unknown) =>
  Result.gen(function* () {
    const response = yield* Schema.decodeUnknownResult(DecisionResponse)(input).pipe(
      Result.mapError(
        (cause) =>
          new DualSignalError({
            message: 'OpenAI decision payload violates typed contract',
            category: 'CONTRACT',
            cause: Redacted.make(cause),
          }),
      ),
    )
    const answer = response.answers[0]
    if (response.answers.length !== 1 || answer?.type !== 'choice')
      return yield* Result.fail(
        new DualSignalError({ message: 'OpenAI decision was refused or omitted', category: 'CONTRACT' }),
      )
    const values = answer.probabilities.map((value) => value.value)
    const mass = answer.probabilities.reduce((sum, value) => sum + value.probability, 0)
    const chosen = answer.probabilities.find((value) => value.value === answer.choice)
    const usage = response.usage
    if (
      values.length !== 3 ||
      new Set(values).size !== 3 ||
      chosen === undefined ||
      mass < 0.98 ||
      mass > 1.02 ||
      chosen.probability + 0.01 < Math.max(...answer.probabilities.map((value) => value.probability)) ||
      usage.input_tokens_details.cached_tokens + usage.input_tokens_details.cache_write_tokens > usage.input_tokens ||
      usage.total_tokens !== usage.input_tokens + usage.output_tokens
    )
      return yield* Result.fail(
        new DualSignalError({ message: 'OpenAI probabilities or usage inconsistent', category: 'CONTRACT' }),
      )
    return response
  })

/** Dedicated fixed endpoint, scoped HTTP proxy, redacted bearer credentials and no retries. */
export const VisualDecisionClientLive = (key: Redacted.Redacted<string>, timeoutMs = 8_000) =>
  Layer.effect(
    VisualDecisionClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      if (Redacted.value(key).length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
        return yield* new DualSignalError({ message: 'OpenAI visual key or deadline invalid', category: 'INPUT' })
      return {
        evaluate: (input: { readonly symbol: string; readonly image: string }) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis
            return yield* Effect.gen(function* () {
              const httpRequest = HttpClientRequest.post(openAiDecisionsEndpoint).pipe(
                HttpClientRequest.bearerToken(key),
                HttpClientRequest.bodyText(JSON.stringify(visualDecisionRequest(input)), 'application/json'),
                HttpClientRequest.acceptJson,
              )
              const response = yield* http.execute(httpRequest)
              if (response.status !== 200)
                return yield* new DualSignalError({
                  message: `OpenAI decision returned HTTP ${response.status}`,
                  category: 'PROVIDER',
                })
              const raw: unknown = yield* response.json
              const verified = yield* Effect.fromResult(decodeVisualDecision(raw))
              const completed = yield* Clock.currentTimeMillis
              if (completed < started || completed - started >= timeoutMs)
                return yield* new DualSignalError({
                  message: 'OpenAI decision exceeded deadline',
                  category: 'DEADLINE',
                })
              return {
                startedAt: utcInstantFromEpochMillis(started),
                completedAt: utcInstantFromEpochMillis(completed),
                responseHash: sha256(JSON.stringify(verified)),
                response: verified,
              }
            }).pipe(
              Effect.timeout(`${timeoutMs} millis`),
              Effect.mapError((cause) =>
                cause instanceof DualSignalError
                  ? cause
                  : new DualSignalError({
                      message: Cause.isTimeoutError(cause)
                        ? 'OpenAI image decision timed out'
                        : 'OpenAI visual transport failed',
                      category: Cause.isTimeoutError(cause) ? 'DEADLINE' : 'PROVIDER',
                      cause: Redacted.make(cause),
                      diagnostic: Cause.isTimeoutError(cause)
                        ? 'TimeoutError'
                        : HttpClientError.isHttpClientError(cause)
                          ? cause.reason._tag
                          : 'UnknownError',
                    }),
              ),
            )
          }),
      }
    }),
  )

export const compareObservedSetups = (jev: JevInference, visual: VisualInference) => {
  const numerical = jev.response.answers['setup']
  const chart = visual.response.answers[0]
  if (numerical?.type !== 'choice' || chart?.type !== 'choice')
    return { status: 'UNCOMPARABLE' as const, jevSetup: null, visualSetup: null }
  return {
    status: numerical.choice === chart.choice ? ('AGREEMENT' as const) : ('DISAGREEMENT' as const),
    jevSetup: numerical.choice,
    visualSetup: chart.choice,
  }
}

const RejectedJevUsage = Schema.Struct({
  model: JevResponseSchema.fields.model,
  usage: JevResponseSchema.fields.usage,
})

/** A rejected decision can still have billable usage, but only from its bound, verified receipt. */
const rejectedJevMetering = (error: JevError, request: JevRequest, requestHash: string) => {
  if (
    error.requestHash !== requestHash ||
    error.responseHash === undefined ||
    error.rejectedResponse === undefined ||
    (error.failure !== JevFailure.Response &&
      error.failure !== JevFailure.Timeout &&
      error.failure !== JevFailure.Status)
  )
    return undefined
  const raw = Redacted.value(error.rejectedResponse)
  const hash = canonicalHashV1Result(raw)
  if (Result.isFailure(hash) || hash.success !== error.responseHash) return undefined
  const receipt = Schema.decodeUnknownResult(RejectedJevUsage)(raw)
  if (Result.isFailure(receipt) || receipt.success.model !== request.model) return undefined
  return { responseHash: hash.success, httpStatus: error.status ?? null, tokens: receipt.success.usage }
}

/** Correlated market views; compare but never combine into an order-authorizing vote. */
export const evaluateDualSignalResearch = (request: JevRequest, sealedSymbol?: string) =>
  Effect.gen(function* () {
    const prepared = yield* Effect.fromResult(prepareJevRequest(request))
    const image = yield* Effect.fromResult(nativeCandlestickEvidence(prepared.request))
    if (sealedSymbol !== undefined && image.symbol !== sealedSymbol)
      return yield* new DualSignalError({ message: 'Chart symbol differs from sealed Jev identity', category: 'INPUT' })
    const jev = yield* JevClient
    const decisions = yield* VisualDecisionClient
    const started = yield* Clock.currentTimeMillis
    const outcomes = yield* Effect.all(
      {
        numerical: jev.evaluate(prepared.request).pipe(Effect.result),
        visual: decisions.evaluate(image).pipe(Effect.result),
      },
      { concurrency: 2 },
    )
    const completed = yield* Clock.currentTimeMillis
    const numerical = Result.isSuccess(outcomes.numerical) ? outcomes.numerical.success : null
    const visual = Result.isSuccess(outcomes.visual) ? outcomes.visual.success : null
    const rejected = Result.isFailure(outcomes.numerical)
      ? rejectedJevMetering(outcomes.numerical.failure, prepared.request, prepared.requestHash)
      : undefined
    const jTokens = numerical?.response.usage.input_tokens ?? rejected?.tokens.input_tokens
    const vUsage = visual?.response.usage
    const vTokens = vUsage?.input_tokens
    const cached = vUsage?.input_tokens_details.cached_tokens ?? 0
    const writes = vUsage?.input_tokens_details.cache_write_tokens ?? 0
    const report = {
      schemaVersion: 'bayn.dual-signal-shadow-report.v2' as const,
      source: {
        requestHash: prepared.requestHash,
        symbol: image.symbol,
        barCount: image.barCount,
        barsHash: image.barsHash,
        imageSha256: image.pngHash,
        visualEndpoint: openAiDecisionsEndpoint,
        visualRequestHash: sha256(JSON.stringify(visualDecisionRequest(image))),
        provenance: image.provenance,
      },
      model: { numerical: 'jev-1.13.0' as const, visual: openAiDecisionsModel },
      timestamps: { startedAt: utcInstantFromEpochMillis(started), completedAt: utcInstantFromEpochMillis(completed) },
      numerical:
        numerical === null
          ? {
              status: 'UNAVAILABLE' as const,
              failure: Result.isFailure(outcomes.numerical) ? outcomes.numerical.failure.failure : 'UNKNOWN',
              ...rejected,
            }
          : {
              status: 'RECEIVED' as const,
              responseHash: numerical.responseHash,
              durationMs: Date.parse(numerical.completedAt) - Date.parse(numerical.startedAt),
              tokens: numerical.response.usage,
              setup:
                numerical.response.answers['setup']?.type === 'choice' ? numerical.response.answers['setup'] : null,
            },
      visual:
        visual === null
          ? {
              status: 'UNAVAILABLE' as const,
              failure: Result.isFailure(outcomes.visual) ? outcomes.visual.failure.category : 'UNKNOWN',
              diagnostic: Result.isFailure(outcomes.visual) ? (outcomes.visual.failure.diagnostic ?? null) : null,
            }
          : {
              status: 'RECEIVED' as const,
              responseHash: visual.responseHash,
              durationMs: Date.parse(visual.completedAt) - Date.parse(visual.startedAt),
              tokens: visual.response.usage,
              setup: visual.response.answers[0]?.type === 'choice' ? visual.response.answers[0] : null,
            },
      comparison:
        numerical !== null && visual !== null
          ? compareObservedSetups(numerical, visual)
          : { status: 'INCOMPLETE' as const, jevSetup: null, visualSetup: null },
      costs: {
        coverage:
          jTokens === undefined || vTokens === undefined ? ('INCOMPLETE' as const) : ('PROVIDER_METERED' as const),
        jevEstimatedPicoUsd: jTokens === undefined ? null : String(BigInt(jTokens) * 42_000n),
        openAiEstimatedPicoUsd:
          vTokens === undefined
            ? null
            : String(
                BigInt(vTokens - cached - writes) * 100_000n + BigInt(cached) * 10_000n + BigInt(writes) * 125_000n,
              ),
        tariffBasis: '2026-10-22-published-list-assumption' as const,
      },
      independentEvidence: false as const,
      tradingAuthority: 'NONE' as const,
    }
    return { ...report, reportHash: sha256(JSON.stringify(report)) }
  })
