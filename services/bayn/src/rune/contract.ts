import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { JevRequestSchema, JevResponseSchema } from '../jev/contract'
import { NonNegativeIntegerSchema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'

export const runeModel = 'rune-v3-c6b360d47895' as const
export const runeEndpoint = 'http://rune.rune.svc.cluster.local:8080/v1/decisions' as const

export const RuneRequestSchema = Schema.Struct({
  model: Schema.Literal(runeModel),
  thinking: Schema.Literal(false),
  state: JevRequestSchema.fields.state,
  questions: JevRequestSchema.fields.questions.check(
    Schema.makeFilter((questions) =>
      Object.values(questions).every((question) =>
        question.type === 'noul'
          ? question.criteria !== undefined
          : question.type !== 'choice' || Object.values(question.criteria).every((value) => value !== null),
      ),
    ),
  ),
})
export type RuneRequest = typeof RuneRequestSchema.Type

export const RuneResponseSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  model: Schema.Literal(runeModel),
  provider: Schema.Literal('surogate'),
  answers: JevResponseSchema.fields.answers,
  usage: Schema.Struct({
    input_tokens: NonNegativeIntegerSchema,
    output_tokens: NonNegativeIntegerSchema,
    cost: Schema.Literal(0),
  }),
})
export type RuneResponse = typeof RuneResponseSchema.Type

export class RuneContractError extends Data.TaggedError('RuneContractError')<{
  readonly message: string
  readonly question?: string
  readonly cause?: unknown
}> {}

export const prepareRuneRequest = (input: unknown) =>
  Schema.decodeUnknownResult(
    RuneRequestSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new RuneContractError({ message: 'Rune request violates its contract', cause })),
    Result.flatMap((request) =>
      Result.all({ requestHash: canonicalHashV1Result(request), body: canonicalJsonV1Result(request) }).pipe(
        Result.mapError((cause) => new RuneContractError({ message: 'Rune request cannot be serialized', cause })),
        Result.flatMap(({ requestHash, body }) =>
          new TextEncoder().encode(body).byteLength > 128_000
            ? Result.fail(new RuneContractError({ message: 'Rune request exceeds the 128000-byte transport budget' }))
            : Result.succeed({ request, requestHash, body }),
        ),
      ),
    ),
  )

const sameKeys = (left: object, right: object): boolean => {
  const keys = Object.keys(left).sort()
  const other = Object.keys(right).sort()
  return keys.length === other.length && keys.every((key, index) => key === other[index])
}

const close = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-9
const invalid = (message: string, question?: string) =>
  Result.fail(new RuneContractError({ message, ...(question === undefined ? {} : { question }) }))

export const decodeRuneResponse = (request: RuneRequest, input: unknown) =>
  Schema.decodeUnknownResult(
    RuneResponseSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new RuneContractError({ message: 'Rune response violates its contract', cause })),
    Result.flatMap((response) => {
      if (!sameKeys(request.questions, response.answers))
        return invalid('Rune answer identities differ from the request')
      if (response.usage.output_tokens !== Object.keys(request.questions).length)
        return invalid('Rune single-pass usage must contain one readout per question')
      for (const [name, question] of Object.entries(request.questions)) {
        const answer = response.answers[name]
        if (answer === undefined || answer.type !== question.type)
          return invalid('Rune answer type differs from the request', name)
        if (question.type === 'noul' || answer.type === 'noul') continue
        const expected =
          question.type === 'score'
            ? Object.fromEntries(question.criteria.map((description, index) => [String(index), description]))
            : question.criteria
        if (!sameKeys(expected, answer.probabilities))
          return invalid('Rune choice identities differ from the request', name)
        const probabilities = Object.values(answer.probabilities)
        const mass = probabilities.reduce((sum, value) => sum + value, 0)
        if (!close(mass, 1)) return invalid('Rune probabilities must sum to one', name)
        const maximum = Math.max(...probabilities)
        if (answer.type === 'choice') {
          const selected = answer.probabilities[answer.choice]
          if (selected === undefined || selected !== maximum)
            return invalid('Rune choice is not a maximum probability', name)
          const uniform = 1 / probabilities.length
          if (!close(answer.confidence, (maximum / mass - uniform) / (1 - uniform)))
            return invalid('Rune choice confidence contradicts its probabilities', name)
          continue
        }
        if (
          question.type !== 'score' ||
          !sameKeys(expected, answer.legend) ||
          Object.entries(expected).some(([level, description]) => answer.legend[level] !== description)
        )
          return invalid('Rune score legend differs from the request', name)
        const score = probabilities.reduce((sum, value, index) => sum + value * index, 0)
        const mode = probabilities.indexOf(maximum)
        const distance = probabilities.reduce((sum, value, index) => sum + (value / mass) * Math.abs(index - mode), 0)
        const center = (probabilities.length - 1) / 2
        const uniformDistance =
          probabilities.reduce((sum, _, index) => sum + Math.abs(index - center), 0) / probabilities.length
        if (!close(answer.score, score) || !close(answer.confidence, Math.max(0, 1 - distance / uniformDistance)))
          return invalid('Rune score or confidence contradicts its probabilities', name)
      }
      return Result.succeed(response)
    }),
  )
