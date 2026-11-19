import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { decodeDecisionsResponse, prepareDecisionsRequest } from './decisions'

// Financial fixture reproduction only; there is no retired provider transport.
export const nativeChartInference = (raw: unknown, at: string) => {
  const prepared = Result.getOrThrow(prepareDecisionsRequest(raw))
  const rawSource = prepared.request.input[0].content[2].data
  const source = Schema.decodeUnknownSync(
    Schema.Struct({
      bars: Schema.Array(Schema.Struct({ id: Schema.String, low: Schema.Number, high: Schema.Number })).check(
        Schema.isMinLength(1),
      ),
    }),
  )(typeof rawSource === 'object' && rawSource !== null && 'source' in rawSource ? rawSource['source'] : rawSource)
  const response = Result.getOrThrow(
    decodeDecisionsResponse(prepared.request, {
      model: prepared.request.model,
      answers: prepared.request.questions.map((question) => {
        if (question.type === 'predicate') return { type: 'predicate', name: question.name, probability: 0.9 }
        const eligible = source.bars.filter((bar) => question.choices.some((choice) => choice.value === bar.id))
        const anchor =
          question.name === 'support_anchor'
            ? eligible.reduce<(typeof eligible)[number] | undefined>(
                (left, right) => (left === undefined || right.low < left.low ? right : left),
                undefined,
              )
            : question.name === 'resistance_anchor'
              ? eligible.reduce<(typeof eligible)[number] | undefined>(
                  (left, right) => (left === undefined || right.high > left.high ? right : left),
                  undefined,
                )
              : question.name === 'base_last_bar'
                ? eligible.at(-1)
                : eligible[0]
        if (anchor === undefined) throw new Error('Missing fixture chart anchor')
        return {
          type: 'choice',
          name: question.name,
          choice: anchor.id,
          confidence: 1,
          probabilities: question.choices.map((choice) => ({
            value: choice.value,
            probability: choice.value === anchor.id ? 1 : 0,
          })),
        }
      }),
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        total_tokens: 100,
      },
    }),
  )
  return {
    requestHash: prepared.requestHash,
    responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
    startedAt: at,
    completedAt: at,
    response,
  }
}
