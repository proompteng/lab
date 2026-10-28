import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import type { NativeChartEvidence } from './chart-evidence'
import { JevContractError } from './contract'
import { jevEntryEconomics } from './entry-economics'
import type { EntryInferenceInput } from './entry-inference-input'
import type { JevProtocolMaterial } from './protocol'
import { makeEntrySourceCandidates } from './entry-proposals'
import type { RetainedConditionalChartAssessmentsMaterial } from './retained-conditional-chart-questions'
import {
  DecisionsRequestSchema,
  decisionsModel,
  prepareDecisionsRequest,
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
      'Does the chart show an identifiable resistance level above executionReference.bidUsd? Repeated rejection at a level is resistance. The latest completed close is historical; use the supplied current quote in USD. A hypothetical price above the chart is not observed resistance.',
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
    instructions:
      'Which offered completed bar has the low that anchors the most recently defended support below the current quote? Choose no_support if none of the offered lows represents defended support. Financial eligibility alone does not establish visible support.',
    noMatch: { value: 'no_support', description: 'None of the eligible source lows identifies defended support.' },
  },
  {
    name: 'resistance_anchor',
    instructions:
      'Which offered completed bar has the high that anchors observed overhead resistance usable as a profit objective beyond the bounded entry? Choose no_resistance if none of the offered highs represents that structure. Financial eligibility alone does not establish visible resistance.',
    noMatch: {
      value: 'no_resistance',
      description: 'None of the eligible source highs identifies overhead resistance.',
    },
  },
] as const
const noBase = { value: 'no_base', description: 'No completed consolidation matches this question.' }
const baseEndInstructions =
  'Which offered bar ends the most recent completed consolidation before the newest directional move? The consolidation must contain at least two completed bars and end before the newest completed bar. Offered intervals satisfy code-owned price and cost checks, which do not prove a consolidation. Choose no_base if none is identifiable.'
const baseStartInstructions =
  'Evaluate a possible consolidation ending at the specified completed bar. Which offered earlier bar begins that same consolidation? Identify the whole contiguous interval, rather than an isolated low or an uninterrupted trend. Financial eligibility does not establish visible structure. Choose no_base if none of the offered intervals is a consolidation with this end.'
const sharedInstructions =
  'Read the completed one-minute candlesticks and volume for the identified symbol. Older bars are on the left. The lower histogram is traded volume. Numbers below the chart are minutes before windowEndAt and match chartLabel in the source bars. The image and source table are the same observations. executionReference supplies the current bid, ask and bounded entry; the latest completed close can differ from that quote. Compare chart prices with the Usd fields, which are dollars. Micros fields are exact integer millionths of a dollar. Code filters offered anchors by executable price and cost checks, not by visual support. Inspect all bars, including closer obstructions outside the offered objectives. Judge visible structure without predicting future prices or inventing a setup to fit an eligible price.'
export const chartQuestionPolicy = {
  model: decisionsModel,
  candidatePolicy: 'funded-source-anchors-for-bounded-entry-v1',
  presenceQuestions,
  anchorQuestions,
  baseEndInstructions,
  baseStartInstructions,
  noBase,
  sharedInstructions,
}

export type ChartDecisionSource = {
  readonly chart: NativeChartEvidence
  readonly protocol: JevProtocolMaterial
  readonly funding: EntryInferenceInput['funding']
}

type PreparedChartRequest = {
  readonly body: string
  readonly requestHash: string
  readonly sourceFeasible: boolean
}
const preparedChartRequests = new Map<string, PreparedChartRequest>()
const detachedChartRequest = (prepared: PreparedChartRequest) =>
  Schema.decodeUnknownResult(
    Schema.fromJsonString(DecisionsRequestSchema),
    strictParseOptions,
  )(prepared.body).pipe(Result.map((request) => ({ ...prepared, request })))

export const buildChartDecisionsRequest = (
  source: ChartDecisionSource,
  stage: 'CHART' | { readonly selectedEnd: string },
) =>
  Result.gen(function* () {
    // Revalidation must hash actual source content; claimed chart hashes cannot establish cache identity.
    const key = yield* canonicalHashV1Result({ source, stage, questionPolicy: chartQuestionPolicy })
    const cached = preparedChartRequests.get(key)
    if (cached !== undefined) return yield* detachedChartRequest(cached)
    const { chart, protocol, funding } = source
    const economics = yield* jevEntryEconomics({
      protocol,
      symbol: chart.symbol,
      bidMicros: BigInt(funding.bidMicros),
      askMicros: BigInt(funding.askMicros),
      capitalMicros: funding.capitalMicros,
      cryptoFeeTier: funding.cryptoFeeTier,
    })
    const candidates =
      economics === null
        ? { supportBarIds: [], resistanceBarIds: [], baseWindows: [] }
        : yield* makeEntrySourceCandidates({ chart, protocol, economics, bidMicros: BigInt(funding.bidMicros) })
    const anchors: DecisionsRequest['questions'][number][] = anchorQuestions.flatMap((question) => {
      const ids = question.name === 'support_anchor' ? candidates.supportBarIds : candidates.resistanceBarIds
      if (ids.length === 0) return []
      return [
        {
          type: 'choice',
          name: question.name,
          instructions: question.instructions,
          choices: [
            ...chart.bars
              .filter((bar) => ids.includes(bar.id))
              .map((bar) => ({
                value: bar.id,
                description:
                  question.name === 'support_anchor'
                    ? `Bar labeled ${bar.chartLabel} minutes before the window end; low ${bar.low} USD at ${bar.timestamp}.`
                    : question.name === 'resistance_anchor'
                      ? `Bar labeled ${bar.chartLabel} minutes before the window end; high ${bar.high} USD at ${bar.timestamp}.`
                      : `Bar labeled ${bar.chartLabel} minutes before the window end, beginning at ${bar.timestamp}.`,
              })),
            question.noMatch,
          ],
        },
      ]
    })
    const baseEnds = chart.bars.filter((bar) => candidates.baseWindows.some((span) => span.lastBarId === bar.id))
    const baseQuestions: DecisionsRequest['questions'][number][] =
      baseEnds.length === 0
        ? []
        : [
            ...(typeof stage === 'object'
              ? []
              : [
                  {
                    type: 'choice' as const,
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
                ]),
            ...(stage === 'CHART'
              ? []
              : baseEnds
                  .filter((end) => end.id === stage.selectedEnd)
                  .map((end) => ({
                    type: 'choice' as const,
                    name: `base_first_bar_ending_${end.chartLabel}`,
                    instructions: `${baseStartInstructions} The specified end is bar labeled ${end.chartLabel} minutes before windowEndAt, beginning at ${end.timestamp}.`,
                    choices: [
                      ...chart.bars
                        .filter((bar) =>
                          candidates.baseWindows.some(
                            (span) => span.lastBarId === end.id && span.firstBarId === bar.id,
                          ),
                        )
                        .map((bar) => ({
                          value: bar.id,
                          description: `Consolidation begins at bar labeled ${bar.chartLabel} minutes before windowEndAt, beginning at ${bar.timestamp}.`,
                        })),
                      noBase,
                    ],
                  }))),
          ]
    const prepared = yield* prepareDecisionsRequest({
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
                executionReference: {
                  bidUsd: Number(BigInt(funding.bidMicros)) / 1_000_000,
                  askUsd: Number(BigInt(funding.askMicros)) / 1_000_000,
                  maximumEntryPriceUsd: economics?.maximumEntryPriceUsd ?? null,
                  bidMicros: funding.bidMicros,
                  askMicros: funding.askMicros,
                  maximumEntryPriceMicros: economics?.maximumEntryPriceMicros ?? null,
                  takeProfitBreakEvenLimitUsd: economics?.takeProfitBreakEvenLimitUsd ?? null,
                  maximumHoldingMinutes: protocol.maximumHoldingMinutes,
                },
              },
            },
          ],
        },
      ],
      questions: typeof stage === 'object' ? baseQuestions : [...presenceQuestions, ...anchors, ...baseQuestions],
    })
    const reusable = {
      body: prepared.body,
      requestHash: prepared.requestHash,
      sourceFeasible:
        candidates.baseWindows.length > 0 ||
        (candidates.supportBarIds.length > 0 && candidates.resistanceBarIds.length > 0),
    }
    // Two stages for a fifteen-candidate cohort fit without retaining an unbounded chart history.
    if (preparedChartRequests.size >= 64) {
      const oldest = preparedChartRequests.keys().next()
      if (oldest.done === false) preparedChartRequests.delete(oldest.value)
    }
    preparedChartRequests.set(key, reusable)
    return yield* detachedChartRequest(reusable)
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Executable chart questions could not be prepared', cause }),
    ),
  )

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
  Schema.Struct({ status: Schema.Literal('NOT_IDENTIFIED') }),
  Schema.Struct({ status: Schema.Literal('REFUSED') }),
])
export const ChartAssessmentsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.chart-assessments.v4'),
  symbol: SymbolSchema,
  windowEndAt: UtcInstantSchema,
  barsHash: Sha256Schema,
  pngHash: Sha256Schema,
  support: Schema.Struct({ presence: Presence, anchor: Anchor }),
  resistance: Schema.Struct({ presence: Presence, anchor: Anchor }),
  base: Schema.Struct({ presence: Presence, first: Anchor, last: Anchor }),
})
export type ChartAssessments = typeof ChartAssessmentsSchema.Type
export type ChartAssessmentsMaterial =
  | ChartAssessments
  | RetainedConditionalChartAssessmentsMaterial
  | import('./retained-funded-chart-questions').ChartAssessments

export const chartAssessmentsFromResponse = (
  chart: NativeChartEvidence,
  response: DecisionsResponse,
  request: DecisionsRequest,
) =>
  Result.gen(function* () {
    const asked = new Set(request.questions.map((question) => question.name))
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
      if (!asked.has(name)) return Result.succeed({ status: 'NOT_IDENTIFIED' })
      const answer = response.answers.find((value) => value.name === name)
      if (answer?.type === 'refusal') return Result.succeed({ status: 'REFUSED' })
      if (answer?.type !== 'choice' || typeof answer.choice !== 'string') return invalid()
      if (['no_base', 'no_support', 'no_resistance'].includes(answer.choice))
        return Result.succeed({ status: 'NOT_IDENTIFIED' })
      const probability = answer.probabilities.find((value) => value.value === answer.choice)?.probability
      return probability === undefined
        ? invalid()
        : Result.succeed({ status: 'ASSESSED', barId: answer.choice, probability })
    }
    const base = yield* Result.gen(function* () {
      const presenceEvidence = yield* presence('base_present')
      if (!asked.has('base_last_bar'))
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
      schemaVersion: 'bayn.chart-assessments.v4' as const,
      symbol: chart.symbol,
      windowEndAt: chart.windowEndAt,
      barsHash: chart.barsHash,
      pngHash: chart.pngHash,
      support: { presence: yield* presence('support_present'), anchor: yield* anchor('support_anchor') },
      resistance: { presence: yield* presence('resistance_present'), anchor: yield* anchor('resistance_anchor') },
      base,
    } satisfies ChartAssessments
  })
