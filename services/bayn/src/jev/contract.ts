import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import {
  NonNegativeIntegerSchema,
  StrictNonEmptyStringSchema,
  UnitIntervalSchema,
  strictParseOptions,
} from '../schemas'

export enum JevFailure {
  Request = 'REQUEST',
  Transport = 'TRANSPORT',
  Status = 'STATUS',
  Response = 'RESPONSE',
  Timeout = 'TIMEOUT',
}

export const jevModel = 'jev-1.13.0' as const
export const jevEndpoint = 'https://api.typesafe.ai/v1/systemone' as const

const QuestionName = StrictNonEmptyStringSchema.check(Schema.isMaxLength(64))
const Instructions = StrictNonEmptyStringSchema.check(Schema.isMaxLength(16_000))
const ChoiceCriteria = Schema.Record(QuestionName, Instructions).check(
  Schema.makeFilter((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 32),
)

const Question = Schema.Union([
  Schema.Struct({ type: Schema.Literal('noul'), instructions: Instructions }),
  Schema.Struct({ type: Schema.Literal('choice'), instructions: Instructions, criteria: ChoiceCriteria }),
])

export const JevRequestSchema = Schema.Struct({
  model: Schema.Literal(jevModel),
  state: Schema.Json,
  questions: Schema.Record(QuestionName, Question).check(
    Schema.makeFilter((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32),
  ),
})

export type JevRequest = typeof JevRequestSchema.Type

const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('noul'), noul: UnitIntervalSchema }),
  Schema.Struct({
    type: Schema.Literal('choice'),
    choice: QuestionName,
    confidence: UnitIntervalSchema,
    probabilities: Schema.Record(QuestionName, UnitIntervalSchema),
  }),
])

export const JevResponseSchema = Schema.Struct({
  model: Schema.Literal(jevModel),
  answers: Schema.Record(QuestionName, Answer),
  usage: Schema.Struct({ input_tokens: NonNegativeIntegerSchema, output_tokens: NonNegativeIntegerSchema }),
})

export type JevResponse = typeof JevResponseSchema.Type

export class JevContractError extends Data.TaggedError('JevContractError')<{
  readonly message: string
  readonly question?: string
  readonly cause?: unknown
}> {}

export const prepareJevRequest = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevRequestSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev request violates its contract', cause })),
    Result.flatMap((request) =>
      Result.all({ requestHash: canonicalHashV1Result(request), body: canonicalJsonV1Result(request) }).pipe(
        Result.mapError((cause) => new JevContractError({ message: 'Jev request cannot be serialized', cause })),
        Result.flatMap(({ requestHash, body }) =>
          new TextEncoder().encode(body).byteLength > 128_000
            ? Result.fail(new JevContractError({ message: 'Jev request exceeds the 128000-byte transport budget' }))
            : Result.succeed({ request, requestHash, body }),
        ),
      ),
    ),
  )

const sameKeys = (left: object, right: object): boolean => {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
}

export const decodeJevResponse = (request: JevRequest, input: unknown): Result.Result<JevResponse, JevContractError> =>
  Schema.decodeUnknownResult(
    JevResponseSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev response violates its contract', cause })),
    Result.flatMap((response) => {
      if (!sameKeys(request.questions, response.answers)) {
        return Result.fail(new JevContractError({ message: 'Jev answer identities differ from the request' }))
      }
      for (const [name, question] of Object.entries(request.questions)) {
        const answer = response.answers[name]
        if (answer === undefined || answer.type !== question.type) {
          return Result.fail(
            new JevContractError({ message: 'Jev answer type differs from the request', question: name }),
          )
        }
        if (question.type !== 'choice' || answer.type !== 'choice') continue
        const probabilities = Object.values(answer.probabilities)
        const selected = answer.probabilities[answer.choice]
        if (!sameKeys(question.criteria, answer.probabilities) || selected === undefined) {
          return Result.fail(
            new JevContractError({ message: 'Jev choice identities differ from the request', question: name }),
          )
        }
        if (Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 1e-6) {
          return Result.fail(
            new JevContractError({ message: 'Jev choice probabilities do not sum to one', question: name }),
          )
        }
        if (probabilities.some((value) => value > selected)) {
          return Result.fail(
            new JevContractError({ message: 'Jev selected choice is not a maximum probability', question: name }),
          )
        }
      }
      return Result.succeed(response)
    }),
  )
