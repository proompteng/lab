import { Cause, Clock, Context, Data, Effect, Layer, Redacted, Result, Schema, Stream } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { canonicalHashV1Result, canonicalJsonWithHashV1Result } from '../hash'
import {
  NonNegativeIntegerSchema,
  Sha256Schema,
  UnitIntervalSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { utcInstantFromEpochMillis } from '../time'

export const decisionsEndpoint = 'https://api.openai.com/v1/decisions'
export const decisionsModel = 'gpt-6-luna'

const Name = Schema.NonEmptyString.check(Schema.isMaxLength(64))
const Instructions = Schema.NonEmptyString.check(Schema.isMaxLength(8_192))
const ChoiceValue = Schema.Union([Schema.String, Schema.Boolean])
const Question = Schema.Union([
  Schema.Struct({ type: Schema.Literal('predicate'), name: Name, instructions: Instructions }),
  Schema.Struct({
    type: Schema.Literal('choice'),
    name: Name,
    instructions: Instructions,
    choices: Schema.Array(Schema.Struct({ value: ChoiceValue, description: Schema.NonEmptyString })).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(255),
    ),
  }),
])

export const DecisionsRequestSchema = Schema.Struct({
  model: Schema.Literal(decisionsModel),
  input: Schema.Tuple([
    Schema.Struct({
      role: Schema.Literal('user'),
      content: Schema.Tuple([
        Schema.Struct({ type: Schema.Literal('input_text'), text: Instructions }),
        Schema.Struct({ type: Schema.Literal('input_image'), image_url: Schema.NonEmptyString }),
        Schema.Struct({ type: Schema.Literal('input_json'), data: Schema.Json }),
      ]),
    }),
  ]),
  questions: Schema.Array(Question).check(Schema.isMinLength(1), Schema.isMaxLength(400)),
})
export type DecisionsRequest = typeof DecisionsRequestSchema.Type

export const DecisionsUsageSchema = Schema.Struct({
  input_tokens: NonNegativeIntegerSchema,
  input_tokens_details: Schema.Struct({
    cached_tokens: NonNegativeIntegerSchema,
    cache_write_tokens: NonNegativeIntegerSchema,
  }),
  output_tokens: NonNegativeIntegerSchema,
  total_tokens: NonNegativeIntegerSchema,
})
const ChoiceProbability = Schema.Struct({ value: ChoiceValue, probability: UnitIntervalSchema })
export const DecisionsResponseSchema = Schema.Struct({
  model: Schema.Literal(decisionsModel),
  answers: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal('predicate'), name: Name, probability: UnitIntervalSchema }),
      Schema.Struct({
        type: Schema.Literal('choice'),
        name: Name,
        choice: ChoiceValue,
        confidence: UnitIntervalSchema,
        probabilities: Schema.Array(ChoiceProbability),
      }),
      Schema.Struct({ type: Schema.Literal('refusal'), name: Schema.NullOr(Name) }),
    ]),
  ),
  usage: DecisionsUsageSchema,
})
export type DecisionsResponse = typeof DecisionsResponseSchema.Type

export class DecisionsError extends Data.TaggedError('DecisionsError')<{
  readonly category: 'REQUEST' | 'TRANSPORT' | 'STATUS' | 'RESPONSE' | 'DEADLINE'
  readonly message: string
  readonly requestHash?: string
  readonly status?: number
  readonly responseHash?: string
  readonly usage?: typeof DecisionsUsageSchema.Type
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const invalid = (message: string) => Result.fail(new DecisionsError({ category: 'RESPONSE', message }))

export const prepareDecisionsRequest = (input: unknown) =>
  Result.gen(function* () {
    const request = yield* Schema.decodeUnknownResult(
      DecisionsRequestSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(
        (cause) =>
          new DecisionsError({
            category: 'REQUEST',
            message: 'Invalid Decisions request',
            cause: Redacted.make(cause),
          }),
      ),
    )
    if (new Set(request.questions.map((question) => question.name)).size !== request.questions.length)
      return yield* Result.fail(
        new DecisionsError({ category: 'REQUEST', message: 'Decisions question names must be unique' }),
      )
    const image = request.input[0].content[1].image_url
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image))
      return yield* Result.fail(
        new DecisionsError({ category: 'REQUEST', message: 'Decisions requires the sealed inline native PNG' }),
      )
    for (const question of request.questions) {
      if (
        question.type === 'choice' &&
        new Set(question.choices.map((choice) => choice.value)).size !== question.choices.length
      )
        return yield* Result.fail(
          new DecisionsError({ category: 'REQUEST', message: 'Decisions choices must be distinct' }),
        )
    }
    const { body, hash: requestHash } = yield* canonicalJsonWithHashV1Result(request).pipe(
      Result.mapError(
        (cause) =>
          new DecisionsError({
            category: 'REQUEST',
            message: 'Decisions request cannot be serialized or hashed',
            cause: Redacted.make(cause),
          }),
      ),
    )
    if (Buffer.byteLength(body) > 1_048_576)
      return yield* Result.fail(
        new DecisionsError({
          category: 'REQUEST',
          message: 'Decisions request exceeds the native chart transport budget',
        }),
      )
    return { request, requestHash, body }
  })

export const validDecisionsUsage = (usage: typeof DecisionsUsageSchema.Type) =>
  usage.input_tokens_details.cached_tokens + usage.input_tokens_details.cache_write_tokens <= usage.input_tokens &&
  usage.input_tokens + usage.output_tokens === usage.total_tokens

const unitMass = (probabilities: readonly number[]) => {
  const lower = probabilities.reduce((sum, probability) => sum + Math.max(0, probability - 0.005), 0)
  const upper = probabilities.reduce((sum, probability) => sum + Math.min(1, probability + 0.005), 0)
  return lower <= 1 + 1e-9 && upper >= 1 - 1e-9
}

export const decodeDecisionsResponse = (request: DecisionsRequest, input: unknown) =>
  Result.gen(function* () {
    const response = yield* Schema.decodeUnknownResult(DecisionsResponseSchema)(input).pipe(
      Result.mapError(
        (cause) =>
          new DecisionsError({
            category: 'RESPONSE',
            message: 'Invalid Decisions response',
            cause: Redacted.make(cause),
          }),
      ),
    )
    if (response.answers.length !== request.questions.length || !validDecisionsUsage(response.usage))
      return yield* invalid('Decisions answer coverage or metering is inconsistent')
    for (const [index, question] of request.questions.entries()) {
      const answer = response.answers[index]
      if (
        answer === undefined ||
        answer.name !== question.name ||
        (answer.type !== 'refusal' && answer.type !== question.type)
      )
        return yield* invalid('Decisions answer name, order or type differs from the request')
      if (answer.type === 'refusal' || answer.type === 'predicate') continue
      if (!unitMass(answer.probabilities.map((entry) => entry.probability)))
        return yield* invalid('Decisions probabilities exceed their reporting allowance')
      if (answer.type === 'choice' && question.type === 'choice') {
        const expected = new Set(question.choices.map((choice) => choice.value))
        const actual = new Set(answer.probabilities.map((entry) => entry.value))
        const selected = answer.probabilities.find((entry) => entry.value === answer.choice)
        if (
          actual.size !== expected.size ||
          actual.size !== answer.probabilities.length ||
          [...actual].some((value) => !expected.has(value)) ||
          selected === undefined ||
          Math.max(...answer.probabilities.map((entry) => entry.probability)) - selected.probability > Number.EPSILON
        )
          return yield* invalid('Decisions selected a value outside the supplied maximum-probability choices')
      }
    }
    return response
  })

export const DecisionsInferenceSchema = Schema.Struct({
  requestHash: Sha256Schema,
  responseHash: Sha256Schema,
  startedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  response: DecisionsResponseSchema,
})
export type DecisionsInference = typeof DecisionsInferenceSchema.Type

export class DecisionsClient extends Context.Service<
  DecisionsClient,
  {
    readonly evaluate: (request: unknown, budgetMs: number) => Effect.Effect<DecisionsInference, DecisionsError>
  }
>()('@proompteng/bayn/DecisionsClient') {}

const metering = Schema.Struct({ model: Schema.Literal(decisionsModel), usage: DecisionsUsageSchema })

export const DecisionsClientLive = (key: Redacted.Redacted<string>, timeoutMs: number) =>
  Layer.effect(
    DecisionsClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      if (Redacted.value(key).length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000)
        return yield* new DecisionsError({
          category: 'REQUEST',
          message: 'Decisions requires a key and a 1-10000ms timeout',
        })
      return {
        evaluate: (input: unknown, budgetMs: number) =>
          Effect.gen(function* () {
            if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 10_000)
              return yield* new DecisionsError({
                category: 'REQUEST',
                message: 'Decisions requires a remaining deadline of 1-10000ms',
              })
            const remainingMs = Math.min(timeoutMs, budgetMs)
            const prepared = yield* Effect.fromResult(prepareDecisionsRequest(input))
            const started = yield* Clock.currentTimeMillis
            let status: number | undefined
            let usage: typeof DecisionsUsageSchema.Type | undefined
            let responseHash: string | undefined
            return yield* Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.post(decisionsEndpoint).pipe(
                  HttpClientRequest.bearerToken(key),
                  HttpClientRequest.bodyText(prepared.body, 'application/json'),
                  HttpClientRequest.acceptJson,
                ),
              )
              status = response.status
              const raw = yield* response.stream.pipe(
                Stream.runFoldEffect(
                  () => Buffer.alloc(0),
                  (body, chunk) =>
                    body.byteLength + chunk.byteLength > 262_144
                      ? Effect.fail(
                          new DecisionsError({
                            category: 'RESPONSE',
                            message: 'Decisions response exceeds its transport budget',
                          }),
                        )
                      : Effect.succeed(Buffer.concat([body, chunk])),
                ),
                Effect.flatMap((body) =>
                  Effect.try({
                    try: (): unknown => JSON.parse(body.toString('utf8')),
                    catch: (cause) =>
                      new DecisionsError({
                        category: 'RESPONSE',
                        message: 'Decisions response is not JSON',
                        cause: Redacted.make(cause),
                      }),
                  }),
                ),
              )
              const hash = canonicalHashV1Result(raw)
              if (Result.isSuccess(hash)) responseHash = hash.success
              const observedUsage = Schema.decodeUnknownResult(metering)(raw)
              if (Result.isSuccess(observedUsage) && validDecisionsUsage(observedUsage.success.usage))
                usage = observedUsage.success.usage
              if (response.status !== 200)
                return yield* new DecisionsError({
                  category: 'STATUS',
                  message: 'Decisions returned an unsuccessful status',
                })
              const decoded = yield* Effect.fromResult(decodeDecisionsResponse(prepared.request, raw))
              const verifiedHash = yield* Effect.fromResult(canonicalHashV1Result(decoded)).pipe(
                Effect.mapError(
                  (cause) =>
                    new DecisionsError({
                      category: 'RESPONSE',
                      message: 'Decisions response cannot be hashed',
                      cause: Redacted.make(cause),
                    }),
                ),
              )
              const completed = yield* Clock.currentTimeMillis
              if (completed < started || completed - started >= remainingMs)
                return yield* new DecisionsError({
                  category: 'DEADLINE',
                  message: 'Decisions response arrived outside its deadline',
                })
              return {
                requestHash: prepared.requestHash,
                responseHash: verifiedHash,
                startedAt: utcInstantFromEpochMillis(started),
                completedAt: utcInstantFromEpochMillis(completed),
                response: decoded,
              }
            }).pipe(
              Effect.timeout(`${remainingMs} millis`),
              Effect.mapError(
                (cause) =>
                  new DecisionsError({
                    category:
                      cause instanceof DecisionsError
                        ? cause.category
                        : Cause.isTimeoutError(cause)
                          ? 'DEADLINE'
                          : 'TRANSPORT',
                    message:
                      cause instanceof DecisionsError
                        ? cause.message
                        : Cause.isTimeoutError(cause)
                          ? 'Decisions inference deadline elapsed'
                          : 'Decisions transport failed',
                    requestHash: prepared.requestHash,
                    ...(status === undefined ? {} : { status }),
                    ...(usage === undefined ? {} : { usage }),
                    ...(responseHash === undefined ? {} : { responseHash }),
                    cause: Redacted.make(cause),
                  }),
              ),
            )
          }),
      }
    }),
  )
