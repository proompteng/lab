import { Result, Schema } from 'effect'

import { SymbolSchema } from '../schemas'
import type { NativeChartEvidence } from './chart-evidence'
import type { ChartAssessments } from './chart-questions'
import { JevContractError, jevModel, prepareJevRequest, type JevRequest, type JevResponse } from './contract'
import { EntrySetup, type EntryProposal } from './entry-proposals'

export const entryJudgmentThresholds = { affirmativeAtLeast: 0.7, negativeAtMost: 0.3 } as const

const questionNames = (setup: EntrySetup) => {
  const prefix = setup === EntrySetup.SupportRecovery ? 'support_recovery' : 'base_breakout'
  return {
    setup: `${prefix}_confirmed`,
    stop: `${prefix}_stop_invalidates`,
    obstruction: `${prefix}_target_obstructed`,
  }
}

export const makeEntryJudgmentRequest = (input: {
  readonly numericalState: Readonly<Record<string, Schema.Json>>
  readonly chart: NativeChartEvidence
  readonly assessments: ChartAssessments
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
    for (const proposal of input.proposals) {
      const names = questionNames(proposal.source.setup)
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
        evidence:
          'Use candidate, benchmark and relativeSignals in the shared state together with sourceEvidence and chartAssessment in these instructions. Chart assessments are model judgments about the same source bars, not independent facts. Proposed order prices are conditional terms, not observations or promised future prices.',
      }
      questions[names.setup] = {
        type: 'noul',
        instructions: {
          question:
            proposal.source.setup === EntrySetup.SupportRecovery
              ? 'Does the latest completed price sequence show recovery after a test of the identified support?'
              : 'Does the latest completed price sequence show acceptance above the identified consolidation?',
          ...context,
        },
        criteria: {
          true:
            proposal.source.setup === EntrySetup.SupportRecovery
              ? 'The support test is followed by an observable recovery in the newest price sequence.'
              : 'Completed candles establish price above the base rather than a brief rejected excursion.',
          false:
            proposal.source.setup === EntrySetup.SupportRecovery
              ? 'Price is still falling through the support area or has not begun a recovery after the test.'
              : 'The newest candles remain inside the base or reject the attempted break above it.',
        },
      }
      questions[names.stop] = {
        type: 'noul',
        instructions: { question: 'Would reaching this proposed stop invalidate the identified setup?', ...context },
        criteria: {
          true: 'The stop lies beyond the support or base whose continued defense is essential to this setup.',
          false:
            'Ordinary movement within the same intact setup can reach the stop, or the selected level has no clear role in invalidating the setup.',
        },
      }
      questions[names.obstruction] = {
        type: 'noul',
        instructions: {
          question: 'Is there observed overhead resistance between the proposed entry and target?',
          ...context,
        },
        criteria: {
          true: 'An identifiable resistance area in the supplied observations lies before the target.',
          false:
            'The supplied observations show clear space to the target, or their first identifiable overhead resistance is beyond it.',
        },
      }
    }
    return yield* prepareJevRequest({
      model: jevModel,
      state: {
        ...input.numericalState,
        schemaVersion: 'bayn.jev-entry-state.v22',
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
      const names = questionNames(proposal.source.setup)
      const setup = input.response.answers[names.setup]
      const stop = input.response.answers[names.stop]
      const obstruction = input.response.answers[names.obstruction]
      if (setup?.type !== 'noul' || stop?.type !== 'noul' || obstruction?.type !== 'noul')
        return yield* Result.fail(
          new JevContractError({ message: 'Entry proposal is missing a required typed judgment' }),
        )
      const { affirmativeAtLeast, negativeAtMost } = entryJudgmentThresholds
      if (setup.noul < affirmativeAtLeast || stop.noul < affirmativeAtLeast || obstruction.noul > negativeAtMost) {
        rejections.push({
          proposalId: proposal.proposalId,
          reason:
            setup.noul <= negativeAtMost
              ? 'SETUP_UNSUPPORTED'
              : stop.noul <= negativeAtMost
                ? 'INVALIDATION_UNSUPPORTED'
                : obstruction.noul >= affirmativeAtLeast
                  ? 'OBJECTIVE_OBSTRUCTED'
                  : 'JUDGMENT_UNCERTAIN',
        })
        continue
      }
      eligible.push({
        proposal,
        judgmentSupport: Math.min(setup.noul, stop.noul, 1 - obstruction.noul),
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
