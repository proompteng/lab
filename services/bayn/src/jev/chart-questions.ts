import { Result } from 'effect'

import { decodeJevResponse, jevModel, prepareJevRequest } from './contract'
import type { NativeChartEvidence } from './chart-evidence'
import { candleProjection } from './chart-projection'
import type { Anchor, ChartAssessments } from './chart-assessments'
import type { JevProtocolMaterial } from './protocol'
import type { EntryInferenceInput } from './entry-inference-input'
import { makeChartSourceCandidates } from './entry-proposals'
import { entryJudgmentThresholds } from './judgment-policy'

export type ChartDecisionSource = {
  readonly chart: NativeChartEvidence
  readonly protocol: JevProtocolMaterial
  readonly funding: EntryInferenceInput['funding']
}
const definitions = {
  support: {
    presence:
      'Does the chart show a defended support level below source.bidUsd? A defended level has an observable rebound after a test. A low at the end of an ongoing decline is not defended support.',
    region:
      'The complete candlestick or candle group which established the most recently defended support below source.bidUsd in `chart`. Enclose the entire candles, including their bodies, high and low wicks and visible width. Do not box only a horizontal price line.',
  },
  resistance: {
    presence:
      'Does the chart show identifiable overhead resistance above source.bidUsd? Repeated rejection at an observed level is resistance. Do not invent a level above the image.',
    region:
      'The complete candlestick or candle group which established the nearest identifiable overhead resistance above source.bidUsd in `chart`. Enclose the entire candles, including their bodies, high and low wicks and visible width. Do not box only a horizontal price line.',
  },
  base: {
    presence:
      'Does the chart show a completed consolidation before the newest directional move? At least two overlapping completed candles form a bounded range. An uninterrupted directional move is not a consolidation.',
    region:
      'The entire most recent completed consolidation in `chart`, from its first candle through its last candle, including their wicks. Exclude the subsequent directional move. The newest completed candle cannot belong to the consolidation.',
  },
} as const
const instructions =
  'Read the completed one-minute candlesticks in chart. Older bars are on the left. The lower histogram is volume, not price. Locate structures only in the upper price plot. Labels below the plot are minutes before windowEndAt and identify the same source bars. The image and source table represent identical observations. Judge visible structure independently of fees and capital. Do not predict prices or invent a setup.'
export const chartQuestionPolicy = {
  model: jevModel,
  transport: 'jev-presence-and-source-bound-box.v1',
  mapping: 'rendered-candle-body-and-wick-overlap.v2',
  coordinateReportingHalfStep: 0.005,
  baseSelection: 'maximal-contiguous-source-window-within-candle-bodies',
  instructions,
  definitions,
  absenceAtMost: entryJudgmentThresholds.negativeAtMost,
}
export const buildChartJevRequest = ({ chart, protocol, funding }: ChartDecisionSource) => {
  const reference = `bayn_chart_image_${chart.pngHash}`
  return prepareJevRequest({
    model: protocol.model,
    state: {
      instructions,
      chart: reference,
      source: {
        symbol: chart.symbol,
        windowEndAt: chart.windowEndAt,
        barsHash: chart.barsHash,
        pngHash: chart.pngHash,
        bars: chart.bars,
        bidUsd: Number(BigInt(funding.bidMicros)) / 1_000_000,
      },
    },
    assets: {
      [reference]: { type: 'image', format: 'png', data_base64: chart.image.slice('data:image/png;base64,'.length) },
    },
    questions: Object.fromEntries(
      Object.entries(definitions).flatMap(([name, definition]) => [
        [`${name}_present`, { type: 'noul', instructions: definition.presence }],
        [`${name}_region`, { type: 'box', instructions: definition.region }],
      ]),
    ),
  })
}

export const chartAssessmentsFromBoxes = (source: ChartDecisionSource, input: unknown) =>
  Result.gen(function* () {
    const { chart, funding } = source
    const request = yield* buildChartJevRequest(source)
    const response = yield* decodeJevResponse(request.request, input)
    const projection = candleProjection(chart.bars)
    const marginX = chartQuestionPolicy.coordinateReportingHalfStep * projection.width + 1
    const marginY = chartQuestionPolicy.coordinateReportingHalfStep * projection.height + 1
    const candidates = makeChartSourceCandidates({ chart, bidMicros: BigInt(funding.bidMicros) })
    const absent = { status: 'NOT_IDENTIFIED' as const }
    const presence = (name: string) => {
      const answer = response.answers[`${name}_present`]
      if (answer?.type !== 'noul') throw new Error('Validated chart presence is missing')
      return { status: 'ASSESSED' as const, probability: answer.noul }
    }
    const region = (name: string) => {
      const answer = response.answers[`${name}_region`]
      if (answer?.type !== 'box') throw new Error('Validated chart Box is missing')
      const { box } = answer
      // Rounded thin regions are retained in the receipt but cannot identify a source candle.
      const selected =
        box.left === box.right || box.top === box.bottom
          ? []
          : projection.bars.filter(
              (bar) =>
                bar.x >= box.left * projection.width - marginX && bar.x <= box.right * projection.width + marginX,
            )
      return { answer, selected }
    }
    const anchor = (name: 'support' | 'resistance'): typeof Anchor.Type => {
      if (presence(name).probability <= entryJudgmentThresholds.negativeAtMost) return absent
      const { answer, selected } = region(name)
      const allowed = name === 'support' ? candidates.supportBarIds : candidates.resistanceBarIds
      const matching = selected.filter((bar) => {
        return (
          allowed.includes(bar.source.id) &&
          bar.low >= answer.box.top * projection.height - marginY &&
          bar.high <= answer.box.bottom * projection.height + marginY
        )
      })
      const selectedAnchor = matching.reduce<(typeof matching)[number] | undefined>((best, bar) => {
        if (best === undefined) return bar
        return (name === 'support' ? bar.source.low <= best.source.low : bar.source.high <= best.source.high)
          ? bar
          : best
      }, undefined)
      return selectedAnchor === undefined
        ? absent
        : { status: 'ASSESSED', barId: selectedAnchor.source.id, probability: answer.confidence }
    }
    const base = () => {
      const evidence = presence('base')
      if (evidence.probability <= entryJudgmentThresholds.negativeAtMost)
        return { presence: evidence, first: absent, last: absent }
      const { answer, selected } = region('base')
      const contained = selected.filter(
        (bar) =>
          bar.bodyTop >= answer.box.top * projection.height - marginY &&
          bar.bodyBottom <= answer.box.bottom * projection.height + marginY,
      )
      if (
        contained.some((bar) => bar.source.id === chart.bars.at(-1)?.id) ||
        contained.some(
          (bar, index) =>
            index > 0 &&
            bar.source.minuteBeforeWindowEnd !== (contained[index - 1]?.source.minuteBeforeWindowEnd ?? 0) - 1,
        )
      )
        return { presence: evidence, first: absent, last: absent }
      const indices = new Map(contained.map((bar, index) => [bar.source.id, index]))
      const window = candidates.baseWindows
        .flatMap((candidate) => {
          const first = indices.get(candidate.firstBarId)
          const last = indices.get(candidate.lastBarId)
          return first === undefined || last === undefined ? [] : [{ ...candidate, first, last }]
        })
        .toSorted((a, b) => b.last - b.first - (a.last - a.first) || b.last - a.last)[0]
      if (window === undefined) return { presence: evidence, first: absent, last: absent }
      return {
        presence: evidence,
        first: { status: 'ASSESSED' as const, barId: window.firstBarId, probability: answer.confidence },
        last: { status: 'ASSESSED' as const, barId: window.lastBarId, probability: answer.confidence },
      }
    }
    return {
      schemaVersion: 'bayn.chart-assessments.v4' as const,
      symbol: chart.symbol,
      windowEndAt: chart.windowEndAt,
      barsHash: chart.barsHash,
      pngHash: chart.pngHash,
      support: { presence: presence('support'), anchor: anchor('support') },
      resistance: { presence: presence('resistance'), anchor: anchor('resistance') },
      base: base(),
    } satisfies ChartAssessments
  })
