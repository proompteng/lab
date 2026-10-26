import { Result, Schema } from 'effect'

import { SymbolSchema } from '../schemas'
import { instrumentMarket, MarketKind } from '../instruments'
import type { NativeChartEvidence } from './chart-evidence'
import type { ChartAssessmentsMaterial } from './chart-questions'
import { JevContractError, jevModel, prepareJevRequest, type JevRequest, type JevResponse } from './contract'
import { EntrySetup, type EntryProposal } from './entry-proposals'
import { jevInstructions } from './instructions'

export const entryJudgmentThresholds = { affirmativeAtLeast: 0.7, negativeAtMost: 0.3 } as const

const questionNames = (setup: EntrySetup, market: MarketKind) => {
  const setupName = setup === EntrySetup.SupportRecovery ? 'support_recovery' : 'base_breakout'
  const prefix = `${market === MarketKind.Equity ? 'equity' : 'crypto'}_${setupName}`
  const common = { setup: `${prefix}_confirmed`, stop: `${prefix}_stop_invalidates` }
  return market === MarketKind.Equity
    ? ({ market: MarketKind.Equity, ...common } as const)
    : ({ market: MarketKind.Crypto, ...common, obstruction: `${prefix}_target_obstructed` } as const)
}

export const entryJudgmentDefinitions = (setup: EntrySetup) => ({
  setup: {
    question:
      setup === EntrySetup.SupportRecovery
        ? 'Does the latest completed price sequence show recovery after a test of the identified support?'
        : 'Does the latest completed price sequence show acceptance above the identified consolidation?',
    criteria: {
      true:
        setup === EntrySetup.SupportRecovery
          ? 'The support test is followed by an observable recovery in the newest price sequence.'
          : 'Completed candles establish price above the base rather than a brief rejected excursion.',
      false:
        setup === EntrySetup.SupportRecovery
          ? 'Price is still falling through the support area or has not begun a recovery after the test.'
          : 'The newest candles remain inside the base or reject the attempted break above it.',
    },
  },
  stop: {
    question: 'Would reaching this proposed stop invalidate the identified setup?',
    criteria: {
      true: 'The stop lies beyond the support or base whose continued defense is essential to this setup.',
      false:
        'Ordinary movement within the same intact setup can reach the stop, or the selected level has no clear role in invalidating the setup.',
    },
  },
})

const cryptoTargetObstruction = {
  question: 'Is there observed overhead resistance between the proposed entry and target?',
  criteria: {
    true: 'An identifiable resistance area in the supplied observations lies before the target.',
    false:
      'The supplied observations show clear space to the target, or their first identifiable overhead resistance is beyond it.',
  },
}

const marketJudgmentPolicy = (market: MarketKind) => ({
  costBasis: market === MarketKind.Equity ? 'equity-cash-fees' : 'crypto-received-asset-and-sell-fees',
  setups: Object.fromEntries(
    Object.values(EntrySetup).map((setup) => [
      setup,
      {
        names: questionNames(setup, market),
        judgments:
          market === MarketKind.Equity
            ? entryJudgmentDefinitions(setup)
            : { ...entryJudgmentDefinitions(setup), obstruction: cryptoTargetObstruction },
      },
    ]),
  ),
})

export const entryJudgmentPolicy = {
  model: jevModel,
  thresholds: entryJudgmentThresholds,
  evidenceInstructions: jevInstructions.entry,
  markets: {
    [MarketKind.Equity]: marketJudgmentPolicy(MarketKind.Equity),
    [MarketKind.Crypto]: marketJudgmentPolicy(MarketKind.Crypto),
  },
}

export const makeEntryJudgmentRequest = (input: {
  readonly numericalState: Readonly<Record<string, Schema.Json>>
  readonly chart: NativeChartEvidence
  readonly assessments: ChartAssessmentsMaterial
  readonly proposals: readonly EntryProposal[]
}) =>
  Result.gen(function* () {
    if (input.proposals.length === 0) return null
    const candidate = yield* Schema.decodeUnknownResult(Schema.Struct({ symbol: SymbolSchema }))(
      input.numericalState['candidate'],
    )
    if (
      candidate.symbol !== input.assessments.symbol ||
      input.chart.barsHash !== input.assessments.barsHash ||
      input.chart.pngHash !== input.assessments.pngHash ||
      input.proposals.some(
        (proposal) => proposal.symbol !== candidate.symbol || proposal.barsHash !== input.assessments.barsHash,
      ) ||
      new Set(input.proposals.map((proposal) => proposal.source.setup)).size !== input.proposals.length
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Entry judgments require one source-bound proposal per setup' }),
      )
    const questions: Record<string, JevRequest['questions'][string]> = {}
    const market = instrumentMarket(candidate.symbol)
    for (const proposal of input.proposals) {
      const names = questionNames(proposal.source.setup, market)
      const source = proposal.source
      const selectedIds =
        source.setup === EntrySetup.SupportRecovery
          ? [source.supportBarId, source.resistanceBarId]
          : [source.firstBarId, source.lastBarId]
      if (selectedIds.some((id) => !input.chart.bars.some((bar) => bar.id === id)))
        return yield* Result.fail(
          new JevContractError({ message: 'Entry question references an anchor outside its chart' }),
        )
      const sourceEvidence =
        source.setup === EntrySetup.SupportRecovery
          ? input.chart.bars.filter((bar) => selectedIds.includes(bar.id))
          : input.chart.bars.filter((bar) => bar.id >= source.firstBarId && bar.id <= source.lastBarId)
      const context = {
        market,
        sourceEvidence,
        chartAssessment:
          source.setup === EntrySetup.SupportRecovery
            ? { support: input.assessments.support, resistance: input.assessments.resistance }
            : { base: input.assessments.base, resistance: input.assessments.resistance },
        proposal: {
          setup: proposal.source.setup,
          source: proposal.source,
          entryPriceUsd: Number(proposal.maximumEntryPriceMicros) / 1_000_000,
          stopPriceUsd: Number(proposal.stopPriceMicros) / 1_000_000,
          targetPriceUsd: Number(proposal.profitLimitPriceMicros) / 1_000_000,
          maximumHoldingMinutes: proposal.maximumHoldingMinutes,
          targetBasis: proposal.source.targetBasis,
        },
        evidence: jevInstructions.entry,
      }
      const definitions = entryJudgmentDefinitions(source.setup)
      for (const key of ['setup', 'stop'] as const) {
        const definition = definitions[key]
        questions[names[key]] = {
          type: 'noul',
          instructions: { question: definition.question, ...context },
          criteria: definition.criteria,
        }
      }
      if (names.market === MarketKind.Crypto)
        questions[names.obstruction] = {
          type: 'noul',
          instructions: { question: cryptoTargetObstruction.question, ...context },
          criteria: cryptoTargetObstruction.criteria,
        }
    }
    return yield* prepareJevRequest({
      model: jevModel,
      state: {
        ...input.numericalState,
        schemaVersion: 'bayn.jev-entry-state.v23',
      },
      questions,
    })
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Proposal-specific Jev questions could not be constructed', cause }),
    ),
  )

export const selectSupportedEntryProposal = (input: {
  readonly proposals: readonly EntryProposal[]
  readonly response: JevResponse
}) =>
  Result.gen(function* () {
    const eligible: {
      readonly proposal: EntryProposal
      readonly judgmentSupport: number
      readonly modeledLossMicros: bigint
    }[] = []
    const rejections: {
      readonly proposalId: string
      readonly reason: 'SETUP_UNSUPPORTED' | 'INVALIDATION_UNSUPPORTED' | 'OBJECTIVE_OBSTRUCTED' | 'JUDGMENT_UNCERTAIN'
    }[] = []
    for (const proposal of input.proposals) {
      const names = questionNames(proposal.source.setup, instrumentMarket(proposal.symbol))
      const setup = input.response.answers[names.setup]
      const stop = input.response.answers[names.stop]
      if (setup?.type !== 'noul' || stop?.type !== 'noul')
        return yield* Result.fail(
          new JevContractError({ message: 'Entry proposal is missing a required typed judgment' }),
        )
      const { affirmativeAtLeast, negativeAtMost } = entryJudgmentThresholds
      if (setup.noul < affirmativeAtLeast || stop.noul < affirmativeAtLeast) {
        rejections.push({
          proposalId: proposal.proposalId,
          reason:
            setup.noul <= negativeAtMost
              ? 'SETUP_UNSUPPORTED'
              : stop.noul <= negativeAtMost
                ? 'INVALIDATION_UNSUPPORTED'
                : 'JUDGMENT_UNCERTAIN',
        })
        continue
      }
      let judgmentSupport = Math.min(setup.noul, stop.noul)
      if (names.market === MarketKind.Crypto) {
        const obstruction = input.response.answers[names.obstruction]
        if (obstruction?.type !== 'noul')
          return yield* Result.fail(
            new JevContractError({ message: 'Crypto entry proposal is missing its target-obstruction judgment' }),
          )
        if (obstruction.noul > negativeAtMost) {
          rejections.push({
            proposalId: proposal.proposalId,
            reason: obstruction.noul >= affirmativeAtLeast ? 'OBJECTIVE_OBSTRUCTED' : 'JUDGMENT_UNCERTAIN',
          })
          continue
        }
        judgmentSupport = Math.min(judgmentSupport, 1 - obstruction.noul)
      }
      eligible.push({
        proposal,
        judgmentSupport,
        modeledLossMicros:
          BigInt(proposal.funding.acquisitionCostMicros) - BigInt(proposal.funding.estimatedStopNetMicros),
      })
    }
    eligible.sort(
      (left, right) =>
        right.judgmentSupport - left.judgmentSupport ||
        (left.modeledLossMicros < right.modeledLossMicros
          ? -1
          : left.modeledLossMicros > right.modeledLossMicros
            ? 1
            : left.proposal.proposalId.localeCompare(right.proposal.proposalId)),
    )
    return { selected: eligible[0] ?? null, rejections }
  })
