// Read-only reproduction of immutable v3 inputs; current inference does not call this policy.
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import type { NativeChartEvidence } from './chart-evidence'
import { JevContractError } from './contract'
import {
  decodeDecisionsResponse,
  decisionsModel,
  prepareDecisionsRequest,
  DecisionsRequestSchema,
  type DecisionsRequest,
  type DecisionsResponse,
} from './decisions'

const presenceQuestions = [
  {
    type: 'predicate',
    name: 'support_present',
    instructions:
      'Does the recent price sequence show a defended support level? A defended level has an observable rebound after price tests it. A low at the end of an ongoing decline is not a defended level.',
  },
  {
    type: 'predicate',
    name: 'resistance_present',
    instructions:
      'Does the chart show an identifiable resistance level above the latest completed close? Repeated rejection at a level is resistance. A hypothetical price above the chart is not observed resistance.',
  },
  {
    type: 'predicate',
    name: 'base_present',
    instructions:
      'Is there a completed consolidation before the newest directional move? A consolidation is a contiguous period of overlapping candles trading in a bounded range. An uninterrupted directional move is not a consolidation.',
  },
] as const

const anchorQuestions = [
  {
    name: 'support_anchor',
    instructions: 'Which completed bar has the low that anchors the most recently defended support level in the chart?',
  },
  {
    name: 'resistance_anchor',
    instructions:
      'Which completed bar has the high that anchors the clearest observed overhead resistance above the latest completed close?',
  },
] as const
const noBase = { value: 'no_base', description: 'No completed consolidation matches this question.' }
const baseEndInstructions =
  'Which bar ends the most recent completed consolidation before the newest directional move? The consolidation must contain at least two completed bars and end before the newest completed bar. Choose no_base if no such consolidation is identifiable.'
const baseStartInstructions =
  'Evaluate a possible consolidation ending at the specified completed bar. Which earlier bar begins that same consolidation? Identify the whole contiguous interval, rather than an isolated low. Choose no_base if the observations do not establish a consolidation with this end.'
const sharedInstructions =
  'Read the completed one-minute candlesticks and volume for the identified symbol. Older bars are on the left. The lower histogram is traded volume. Numbers below the chart are minutes before windowEndAt and match chartLabel in the source bars. The image and source table are two representations of the same observations. Judge visible structure, without predicting future prices or using outside information.'
export const retainedConditionalChartQuestionPolicy = {
  model: decisionsModel,
  presenceQuestions,
  anchorQuestions,
  baseEndInstructions,
  baseStartInstructions,
  noBase,
  sharedInstructions,
}

const buildChartDecisionsRequest = (chart: NativeChartEvidence) => {
  const anchors: DecisionsRequest['questions'][number][] =
    chart.bars.length < 2
      ? []
      : anchorQuestions.map((question) => ({
          type: 'choice',
          name: question.name,
          instructions: question.instructions,
          choices: chart.bars.map((bar) => ({
            value: bar.id,
            description:
              question.name === 'support_anchor'
                ? `Bar labeled ${bar.chartLabel} minutes before the window end; low ${bar.low} USD at ${bar.timestamp}.`
                : question.name === 'resistance_anchor'
                  ? `Bar labeled ${bar.chartLabel} minutes before the window end; high ${bar.high} USD at ${bar.timestamp}.`
                  : `Bar labeled ${bar.chartLabel} minutes before the window end, beginning at ${bar.timestamp}.`,
          })),
        }))
  const baseEnds = chart.bars.slice(1, -1)
  const baseQuestions: DecisionsRequest['questions'][number][] =
    baseEnds.length === 0
      ? []
      : [
          {
            type: 'choice',
            name: 'base_last_bar',
            instructions: baseEndInstructions,
            choices: [
              ...baseEnds.map((bar) => ({
                value: bar.id,
                description: `Consolidation ends at bar labeled ${bar.chartLabel} minutes before windowEndAt, beginning at ${bar.timestamp}.`,
              })),
              noBase,
            ],
          },
          ...baseEnds.map((end) => ({
            type: 'choice' as const,
            name: `base_first_bar_ending_${end.chartLabel}`,
            instructions: `${baseStartInstructions} The specified end is bar labeled ${end.chartLabel} minutes before windowEndAt, beginning at ${end.timestamp}.`,
            choices: [
              ...chart.bars
                .filter((bar) => bar.timestamp < end.timestamp)
                .map((bar) => ({
                  value: bar.id,
                  description: `Consolidation begins at bar labeled ${bar.chartLabel} minutes before windowEndAt, beginning at ${bar.timestamp}.`,
                })),
              noBase,
            ],
          })),
        ]
  return prepareDecisionsRequest({
    model: decisionsModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: sharedInstructions,
          },
          { type: 'input_image', image_url: chart.image },
          {
            type: 'input_json',
            data: {
              symbol: chart.symbol,
              windowEndAt: chart.windowEndAt,
              barsHash: chart.barsHash,
              pngHash: chart.pngHash,
              bars: chart.bars,
            },
          },
        ],
      },
    ],
    questions: [...presenceQuestions, ...anchors, ...baseQuestions],
  })
}

const preparedChartRequests = new Map<string, { readonly body: string; readonly requestHash: string }>()

export const makeRetainedConditionalChartDecisionsRequest = (chart: NativeChartEvidence) =>
  Result.gen(function* () {
    const key = yield* canonicalHashV1Result({ chart, questionPolicy: retainedConditionalChartQuestionPolicy }).pipe(
      Result.mapError((cause) => new JevContractError({ message: 'Chart request source cannot be hashed', cause })),
    )
    const cached = preparedChartRequests.get(key)
    if (cached !== undefined) {
      const request = yield* Schema.decodeUnknownResult(
        Schema.fromJsonString(DecisionsRequestSchema),
        strictParseOptions,
      )(cached.body).pipe(
        Result.mapError((cause) => new JevContractError({ message: 'Cached chart request cannot be decoded', cause })),
      )
      return { request, ...cached }
    }
    const prepared = yield* buildChartDecisionsRequest(chart)
    preparedChartRequests.set(key, { body: prepared.body, requestHash: prepared.requestHash })
    if (preparedChartRequests.size > 32) {
      const oldest = preparedChartRequests.keys().next().value
      if (oldest !== undefined) preparedChartRequests.delete(oldest)
    }
    return prepared
  })

const Presence = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ASSESSED'),
    probability: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({ status: Schema.Literal('REFUSED') }),
])
const Anchor = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ASSESSED'),
    barId: Schema.NonEmptyString,
    probability: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({ status: Schema.Literal('SOURCE_SINGLETON'), barId: Schema.NonEmptyString }),
  Schema.Struct({ status: Schema.Literal('NOT_IDENTIFIED') }),
  Schema.Struct({ status: Schema.Literal('REFUSED') }),
])
export const RetainedConditionalChartAssessmentsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.chart-assessments.v2'),
  symbol: SymbolSchema,
  windowEndAt: UtcInstantSchema,
  barsHash: Sha256Schema,
  pngHash: Sha256Schema,
  support: Schema.Struct({ presence: Presence, anchor: Anchor }),
  resistance: Schema.Struct({ presence: Presence, anchor: Anchor }),
  base: Schema.Struct({ presence: Presence, first: Anchor, last: Anchor }),
})
export type RetainedConditionalChartAssessments = typeof RetainedConditionalChartAssessmentsSchema.Type
export type RetainedConditionalChartAssessmentsMaterial = Omit<RetainedConditionalChartAssessments, 'schemaVersion'> & {
  readonly schemaVersion: 'bayn.chart-assessments.v1' | 'bayn.chart-assessments.v2'
}

export const retainedConditionalChartAssessments = (chart: NativeChartEvidence, input: unknown) =>
  Result.gen(function* () {
    const prepared = yield* makeRetainedConditionalChartDecisionsRequest(chart)
    const response = yield* decodeDecisionsResponse(prepared.request, input)
    return yield* retainedConditionalChartAssessmentsFromResponse(chart, response)
  })

export const retainedConditionalChartAssessmentsFromResponse = (
  chart: NativeChartEvidence,
  response: DecisionsResponse,
) =>
  Result.gen(function* () {
    const invalid = () =>
      Result.fail(new JevContractError({ message: 'Chart assessment does not match its source-bound question' }))
    const presence = (name: string): Result.Result<typeof Presence.Type, JevContractError> => {
      const answer = response.answers.find((value) => value.name === name)
      if (answer?.type === 'refusal') return Result.succeed({ status: 'REFUSED' })
      return answer?.type === 'predicate'
        ? Result.succeed({ status: 'ASSESSED', probability: answer.probability })
        : invalid()
    }
    const anchor = (name: string): Result.Result<typeof Anchor.Type, JevContractError> => {
      const only = chart.bars[0]
      if (chart.bars.length === 1 && only !== undefined)
        return Result.succeed({ status: 'SOURCE_SINGLETON', barId: only.id })
      const answer = response.answers.find((value) => value.name === name)
      if (answer?.type === 'refusal') return Result.succeed({ status: 'REFUSED' })
      if (answer?.type !== 'choice' || typeof answer.choice !== 'string') return invalid()
      if (answer.choice === 'no_base') return Result.succeed({ status: 'NOT_IDENTIFIED' })
      const probability = answer.probabilities.find((value) => value.value === answer.choice)?.probability
      return probability === undefined
        ? invalid()
        : Result.succeed({ status: 'ASSESSED', barId: answer.choice, probability })
    }
    const base = yield* Result.gen(function* () {
      const presenceEvidence = yield* presence('base_present')
      if (chart.bars.length < 3)
        return {
          presence: presenceEvidence,
          first: { status: 'NOT_IDENTIFIED' as const },
          last: { status: 'NOT_IDENTIFIED' as const },
        }
      const last = yield* anchor('base_last_bar')
      if (last.status === 'REFUSED' || last.status === 'NOT_IDENTIFIED')
        return { presence: presenceEvidence, first: last, last }
      if (last.status !== 'ASSESSED') return yield* invalid()
      const end = chart.bars.find((bar) => bar.id === last.barId)
      if (end === undefined) return yield* invalid()
      const first = yield* anchor(`base_first_bar_ending_${end.chartLabel}`)
      return { presence: presenceEvidence, first, last }
    })
    return {
      schemaVersion: 'bayn.chart-assessments.v2' as const,
      symbol: chart.symbol,
      windowEndAt: chart.windowEndAt,
      barsHash: chart.barsHash,
      pngHash: chart.pngHash,
      support: { presence: yield* presence('support_present'), anchor: yield* anchor('support_anchor') },
      resistance: { presence: yield* presence('resistance_present'), anchor: yield* anchor('resistance_anchor') },
      base,
    } satisfies RetainedConditionalChartAssessments
  })
