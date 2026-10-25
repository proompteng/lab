import { Result, Schema } from 'effect'

import { Sha256Schema, SymbolSchema, UtcInstantSchema } from '../schemas'
import type { NativeChartEvidence } from './chart-evidence'
import { JevContractError } from './contract'
import { decodeDecisionsResponse, decisionsModel, prepareDecisionsRequest, type DecisionsRequest } from './decisions'

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

export const makeChartDecisionsRequest = (chart: NativeChartEvidence) => {
  const anchors: DecisionsRequest['questions'][number][] =
    chart.bars.length < 2
      ? []
      : [
          {
            type: 'choice',
            name: 'support_anchor',
            instructions:
              'Which completed bar has the low that anchors the most recently defended support level in the chart?',
            choices: chart.bars.map((bar) => ({
              value: bar.id,
              description: `Bar labeled ${bar.chartLabel} minutes before the window end; low ${bar.low} USD at ${bar.timestamp}.`,
            })),
          },
          {
            type: 'choice',
            name: 'resistance_anchor',
            instructions:
              'Which completed bar has the high that anchors the clearest observed overhead resistance above the latest completed close?',
            choices: chart.bars.map((bar) => ({
              value: bar.id,
              description: `Bar labeled ${bar.chartLabel} minutes before the window end; high ${bar.high} USD at ${bar.timestamp}.`,
            })),
          },
          {
            type: 'choice',
            name: 'base_first_bar',
            instructions:
              'Which bar begins the most recent completed consolidation before the newest directional move? Identify the first bar of that consolidation.',
            choices: chart.bars.map((bar) => ({
              value: bar.id,
              description: `Bar labeled ${bar.chartLabel} minutes before the window end, beginning at ${bar.timestamp}.`,
            })),
          },
          {
            type: 'choice',
            name: 'base_last_bar',
            instructions:
              'Which bar ends the most recent completed consolidation before the newest directional move? Identify the last bar of that consolidation, before the move begins.',
            choices: chart.bars.map((bar) => ({
              value: bar.id,
              description: `Bar labeled ${bar.chartLabel} minutes before the window end, beginning at ${bar.timestamp}.`,
            })),
          },
        ]
  return prepareDecisionsRequest({
    model: decisionsModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Read the completed one-minute candlesticks and volume for the identified symbol. Older bars are on the left. The lower histogram is traded volume. Numbers below the chart are minutes before windowEndAt and match chartLabel in the source bars. The image and source table are two representations of the same observations. Judge visible structure, without predicting future prices or using outside information.',
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
    questions: [...presenceQuestions, ...anchors],
  })
}

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
  Schema.Struct({ status: Schema.Literal('REFUSED') }),
])
export const ChartAssessmentsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.chart-assessments.v1'),
  symbol: SymbolSchema,
  windowEndAt: UtcInstantSchema,
  barsHash: Sha256Schema,
  pngHash: Sha256Schema,
  support: Schema.Struct({ presence: Presence, anchor: Anchor }),
  resistance: Schema.Struct({ presence: Presence, anchor: Anchor }),
  base: Schema.Struct({ presence: Presence, first: Anchor, last: Anchor }),
})
export type ChartAssessments = typeof ChartAssessmentsSchema.Type

export const chartAssessments = (chart: NativeChartEvidence, input: unknown) =>
  Result.gen(function* () {
    const prepared = yield* makeChartDecisionsRequest(chart)
    const response = yield* decodeDecisionsResponse(prepared.request, input)
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
      const probability = answer.probabilities.find((value) => value.value === answer.choice)?.probability
      return probability === undefined
        ? invalid()
        : Result.succeed({ status: 'ASSESSED', barId: answer.choice, probability })
    }
    return {
      schemaVersion: 'bayn.chart-assessments.v1' as const,
      symbol: chart.symbol,
      windowEndAt: chart.windowEndAt,
      barsHash: chart.barsHash,
      pngHash: chart.pngHash,
      support: { presence: yield* presence('support_present'), anchor: yield* anchor('support_anchor') },
      resistance: { presence: yield* presence('resistance_present'), anchor: yield* anchor('resistance_anchor') },
      base: {
        presence: yield* presence('base_present'),
        first: yield* anchor('base_first_bar'),
        last: yield* anchor('base_last_bar'),
      },
    } satisfies ChartAssessments
  })
