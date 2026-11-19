// Historical OpenAI Decisions evidence codec. Active inference uses JevClient only.
import { Data, Redacted, Result, Schema } from 'effect'

import { canonicalJsonWithHashV1Result } from '../hash'
import {
  NonNegativeIntegerSchema,
  Sha256Schema,
  UnitIntervalSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

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
  readonly providerErrorCode?: string
  readonly providerErrorType?: string
  readonly providerRequestId?: string
  readonly providerRetryAtMs?: number
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
