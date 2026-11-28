import { BigDecimal, Result, Schema } from 'effect'

import { prepareJevRequest, JevContractError } from './contract'
import { canonicalHashV1Result } from '../hash'
import { makeEntryJudgmentRequest } from './entry-questions'
import type { NativeEntryProposal } from './native-entry-proposal'
import { isLongEntryProposal, isShortEntryProposal } from './native-entry-proposal'
import { ShortEntrySetup } from './short-entry'

export const shortQuestionNames = (setup: ShortEntrySetup) => {
  const name = setup === ShortEntrySetup.ResistanceRejection ? 'resistance_rejection' : 'base_breakdown'
  return {
    setup: `equity_${name}_confirmed`,
    stop: `equity_${name}_stop_invalidates`,
    obstruction: `equity_${name}_target_obstructed`,
  }
}
export const shortEntryJudgmentPolicy = {
  stateDefinition: 'bayn.jev-long-short-proposal-evidence.v1',
  openingPolicy: 'regular-session-whole-share-easy-to-borrow-bracket-with-150-percent-collateral',
  instructions:
    'Use the same completed source candles at their observed prices. Assess resistance rejection and downside consolidation breaks independently of long setups. Short entries sell at the bid; covers buy at the ask. A short stop is above entry and a target is below entry. Never invert bullish probabilities or treat a falling price alone as a confirmed setup. Use available supplemental Webull context independently, preserving its source and availability limits.',
  resistanceRejection: {
    question: 'Does the latest completed price sequence show rejection after a test of the identified resistance?',
    criteria: {
      true: 'The resistance test is followed by an observable rejection and movement lower in completed candles.',
      false:
        'Price continues rising through the resistance area, accepts above it, has not tested it, or has not begun to reject the test.',
    },
  },
  baseBreakdown: {
    question: 'Does the latest completed price sequence show acceptance below the identified completed consolidation?',
    criteria: {
      true: 'Completed candles establish price below the base rather than a brief rejected excursion.',
      false:
        'The newest candles remain inside the base, reject the attempted break below it, or show an uninterrupted decline without a completed consolidation.',
    },
  },
  stop: {
    question: 'Would reaching this proposed upper stop invalidate the identified short setup?',
    criteria: {
      true: 'The stop lies above the resistance or upper base boundary whose continued rejection is essential to this setup.',
      false:
        'An ordinary rebound inside the intact setup can reach the stop, or the selected level has no clear role in invalidating the setup.',
    },
  },
  obstruction: {
    question: 'Is there observed support between the proposed short entry and downside target?',
    criteria: {
      true: 'An identifiable support area in the supplied observations lies before the target.',
      false:
        'The supplied observations show clear space to the target, or their first identifiable support is at or below the target.',
    },
  },
} as const

export const symmetricShortEntryJudgmentPolicy = {
  ...shortEntryJudgmentPolicy,
  stateDefinition: 'bayn.jev-long-short-proposal-evidence.v2',
  instructions:
    'Use the named proposal evidence and completedSourceBars in state. calculatedFacts are exact comparisons computed by code from these source bars and proposal terms. They do not prove that the identified structure is meaningful. chartAssessment contains model judgments about these same source bars, not independent observations. Assess resistance rejection and downside consolidation breaks symmetrically with long setups at observed prices. Short entries sell at the bid; covers buy at the ask. A short stop is above entry and a target is below entry. Proposed order prices are conditional terms, not observed or promised future prices. Answer only the individual question supplied here. Use available webullContext as an independent completed-minute observation for the same symbol and window. Keep its prices and volume separate from completedSourceBars. It is supplemental context, not an executable quote or proof of consolidated coverage.',
} as const

export const makeNativeEntryJudgmentRequest = (
  input: Omit<Parameters<typeof makeEntryJudgmentRequest>[0], 'proposals'> & {
    readonly proposals: readonly NativeEntryProposal[]
    readonly symmetric?: boolean
  },
) =>
  Result.gen(function* () {
    const symmetric = input.symmetric === true
    const policy = symmetric ? symmetricShortEntryJudgmentPolicy : shortEntryJudgmentPolicy
    const long = yield* makeEntryJudgmentRequest({
      ...input,
      includeEquityObstruction: symmetric,
      proposals: input.proposals.filter(isLongEntryProposal),
    })
    const shorts = input.proposals.filter(isShortEntryProposal)
    if (shorts.length === 0) return long
    const candidate = yield* Schema.decodeUnknownResult(Schema.Struct({ symbol: Schema.String }))(
      input.numericalState['candidate'],
    )
    const assessmentsHash = yield* canonicalHashV1Result(input.assessments)
    if (
      candidate.symbol !== input.chart.symbol ||
      new Set(shorts.map((proposal) => proposal.source.setup)).size !== shorts.length ||
      shorts.some(
        (proposal) =>
          proposal.symbol !== candidate.symbol ||
          proposal.barsHash !== input.chart.barsHash ||
          proposal.chartAssessmentsHash !== assessmentsHash,
      )
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Short judgments require one exact source-bound proposal per setup' }),
      )
    const longState =
      long === null
        ? {}
        : yield* Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(long.request.state)
    const longProposals =
      longState['proposals'] === undefined
        ? {}
        : yield* Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(longState['proposals'])
    const proposals: Record<string, Schema.Json> = {}
    const questions: Record<string, NonNullable<typeof long>['request']['questions'][string]> = {
      ...long?.request.questions,
    }
    for (const proposal of shorts) {
      const source = proposal.source
      const resistance = source.setup === ShortEntrySetup.ResistanceRejection
      const selectedIds = resistance
        ? [source.supportBarId, source.resistanceBarId]
        : [source.firstBarId, source.lastBarId]
      const structure = input.chart.bars.filter((b) =>
        resistance ? b.id === source.resistanceBarId : b.id >= source.firstBarId && b.id <= source.lastBarId,
      )
      const end = resistance ? source.resistanceBarId : source.lastBarId
      if (structure.length === 0 || selectedIds.some((id) => !input.chart.bars.some((bar) => bar.id === id)))
        return yield* Result.fail(
          new JevContractError({ message: 'Short question anchors must belong to the supplied chart' }),
        )
      const after = input.chart.bars.filter((bar) => bar.id > end)
      const low = Math.min(...structure.map((bar) => bar.low))
      const high = Math.max(...structure.map((bar) => bar.high))
      const lowPrice = BigDecimal.fromNumberUnsafe(low)
      const highPrice = BigDecimal.fromNumberUnsafe(high)
      const completedCloses = after.map((bar) => ({
        barId: bar.id,
        closeRelativeToStructure: BigDecimal.isLessThan(BigDecimal.fromNumberUnsafe(bar.close), lowPrice)
          ? ('BELOW' as const)
          : BigDecimal.isGreaterThan(BigDecimal.fromNumberUnsafe(bar.close), highPrice)
            ? ('ABOVE' as const)
            : ('INSIDE' as const),
      }))
      let consecutiveBelow = 0
      for (const close of completedCloses.toReversed()) {
        if (close.closeRelativeToStructure !== 'BELOW') break
        consecutiveBelow++
      }
      const stop = BigDecimal.make(BigInt(proposal.stopPriceMicros), 6)
      proposals[source.setup] = {
        ...(symmetric
          ? {}
          : {
              structureBars: structure,
              completedBarsAfterStructure: after,
            }),
        sourceEvidence: input.chart.bars.filter((b) => selectedIds.includes(b.id)),
        calculatedFacts: {
          structureLowUsd: low,
          structureHighUsd: high,
          stopIsAboveStructureHigh: BigDecimal.isGreaterThan(stop, highPrice),
          entryIsBelowStructureLow: BigDecimal.isLessThan(
            BigDecimal.make(BigInt(proposal.minimumEntryPriceMicros), 6),
            lowPrice,
          ),
          ...(symmetric
            ? {
                completedBarsAfterStructure: after.length,
                completedClosesAfterStructure: completedCloses,
              }
            : {}),
          consecutiveNewestClosesBelowStructure: consecutiveBelow,
          stopTouchedInCompletedBarsAfterStructure: after.some((bar) =>
            BigDecimal.isGreaterThanOrEqualTo(BigDecimal.fromNumberUnsafe(bar.high), stop),
          ),
        },
        chartAssessment: resistance
          ? { support: input.assessments.support, resistance: input.assessments.resistance }
          : { base: input.assessments.base, support: input.assessments.support },
        terms: {
          ...(symmetric ? { setup: source.setup, targetBasis: source.targetBasis } : {}),
          positionSide: 'SHORT',
          source,
          minimumEntryPriceUsd: Number(proposal.minimumEntryPriceMicros) / 1e6,
          stopPriceUsd: Number(proposal.stopPriceMicros) / 1e6,
          stopLimitPriceUsd: Number(proposal.stopLimitPriceMicros) / 1e6,
          targetPriceUsd: Number(proposal.profitLimitPriceMicros) / 1e6,
          maximumHoldingMinutes: proposal.maximumHoldingMinutes,
          funding: proposal.funding,
        },
      }
      const names = shortQuestionNames(source.setup)
      for (const key of ['setup', 'stop', 'obstruction'] as const) {
        const definition =
          key === 'setup' ? (resistance ? policy.resistanceRejection : policy.baseBreakdown) : policy[key]
        questions[names[key]] = {
          type: 'noul',
          instructions: {
            question: definition.question,
            evidence: policy.instructions,
            proposalEvidencePath: `proposals.${source.setup}`,
          },
          criteria: definition.criteria,
        }
      }
    }
    return yield* prepareJevRequest({
      model: input.model ?? 'jev-1.14.0',
      state: {
        ...longState,
        schemaVersion: policy.stateDefinition,
        symbol: input.chart.symbol,
        windowEndAt: input.chart.windowEndAt,
        completedSourceBars: input.chart.bars,
        webullContext: input.numericalState['webullContext'] ?? null,
        proposals: { ...longProposals, ...proposals },
      },
      questions,
    })
  })
