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
const Instructions = Schema.Json.check(
  Schema.makeFilter((value) =>
    typeof value === 'string'
      ? value.trim().length > 0
      : value !== null && typeof value === 'object' && Object.keys(value).length > 0,
  ),
)
const ChoiceCriteria = Schema.Record(QuestionName, Schema.NullOr(Instructions)).check(
  Schema.makeFilter((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255),
)

const Question = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('noul'),
    instructions: Instructions,
    criteria: Schema.optionalKey(Schema.Struct({ true: Instructions, false: Instructions })),
  }),
  Schema.Struct({ type: Schema.Literal('choice'), instructions: Instructions, criteria: ChoiceCriteria }),
  Schema.Struct({
    type: Schema.Literal('score'),
    instructions: Instructions,
    criteria: Schema.Array(StrictNonEmptyStringSchema).check(Schema.isLengthBetween(2, 10)),
  }),
])

export const JevRequestSchema = Schema.Struct({
  model: Schema.Literal(jevModel),
  state: Schema.Json.check(
    Schema.makeFilter((value) => typeof value === 'string' || (value !== null && typeof value === 'object')),
  ),
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
  Schema.Struct({
    type: Schema.Literal('score'),
    score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
    confidence: UnitIntervalSchema,
    probabilities: Schema.Record(QuestionName, UnitIntervalSchema),
    legend: Schema.Record(QuestionName, Schema.String),
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

// Bayn bounds the SDK's approximate probabilities without changing the retained provider values.
const reportingHalfStep = 0.005

const probabilitiesMatchUnitMass = (probabilities: ReadonlyArray<number>): boolean => {
  let lowerMass = 0
  let upperMass = 0
  for (const probability of probabilities) {
    lowerMass += Math.max(0, probability - reportingHalfStep)
    upperMass += Math.min(1, probability + reportingHalfStep)
  }
  return lowerMass <= 1 + 1e-9 && upperMass >= 1 - 1e-9
}

const scoreMatchesProbabilities = (score: number, probabilities: Readonly<Record<string, number>>): boolean => {
  const levels = Object.entries(probabilities)
    .map(([level, probability]) => ({
      level: Number(level),
      lower: Math.max(0, probability - reportingHalfStep),
      upper: Math.min(1, probability + reportingHalfStep),
    }))
    .sort((left, right) => left.level - right.level)
  const lowerMass = levels.reduce((sum, value) => sum + value.lower, 0)
  const lowerMean = levels.reduce((sum, value) => sum + value.level * value.lower, 0)
  const bound = (ordered: typeof levels): number => {
    let remaining = 1 - lowerMass
    let mean = lowerMean
    for (const value of ordered) {
      const mass = Math.min(remaining, value.upper - value.lower)
      mean += value.level * mass
      remaining -= mass
    }
    return mean
  }
  return (
    score >= bound(levels) - reportingHalfStep - 1e-9 && score <= bound(levels.toReversed()) + reportingHalfStep + 1e-9
  )
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
        if (question.type === 'noul' || answer.type === 'noul') continue
        const probabilities = Object.values(answer.probabilities)
        const expected =
          question.type === 'score'
            ? Object.fromEntries(question.criteria.map((description, index) => [String(index), description]))
            : question.criteria
        if (!sameKeys(expected, answer.probabilities)) {
          return Result.fail(
            new JevContractError({ message: 'Jev choice identities differ from the request', question: name }),
          )
        }
        if (!probabilitiesMatchUnitMass(probabilities)) {
          return Result.fail(
            new JevContractError({ message: 'Jev probabilities exceed the reporting allowance', question: name }),
          )
        }
        if (answer.type === 'score') {
          if (
            question.type !== 'score' ||
            answer.score > question.criteria.length - 1 ||
            !sameKeys(expected, answer.legend) ||
            Object.entries(expected).some(([level, description]) => answer.legend[level] !== description)
          ) {
            return Result.fail(
              new JevContractError({ message: 'Jev score levels differ from the request', question: name }),
            )
          }
          if (!scoreMatchesProbabilities(answer.score, answer.probabilities)) {
            return Result.fail(
              new JevContractError({ message: 'Jev score contradicts its probability distribution', question: name }),
            )
          }
          continue
        }
        const selected = answer.probabilities[answer.choice]
        if (selected === undefined || probabilities.some((value) => value > selected)) {
          return Result.fail(
            new JevContractError({ message: 'Jev selected choice is not a maximum probability', question: name }),
          )
        }
      }
      return Result.succeed(response)
    }),
  )
