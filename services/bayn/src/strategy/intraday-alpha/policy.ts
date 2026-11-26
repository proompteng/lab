import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../../contracts'
import { canonicalHashV1Result, sha256 } from '../../hash'
import { MarketKind } from '../../instruments'
import { JevContractError, jevModel } from '../../jev/contract'
import { retainedEquityMarketProfile } from '../../jev/markets'
import { JevProtocolSchema, type JevProtocolMaterial } from '../../jev/protocol'
import { IntradayBenchmarkEvidencePolicy } from '../../market-data/intraday/model'
import { noiseAreaCheckpointMinutes } from '../../market-data/intraday/trailing-baseline'
import { strictParseOptions } from '../../schemas'
import { currentEquityUniverse } from '../intraday-market'
import {
  IntradayAlphaPhase,
  IntradayAlphaSetup,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquitySymbols,
  intradayAlphaNoiseAreaSymbols,
} from './constants'

export {
  IntradayAlphaPhase,
  IntradayAlphaSetup,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquitySymbols,
  intradayAlphaNoiseAreaSymbols,
}

/**
 * Matches live Dorvud/Flink torghut-core-equity-v3 identity for the 20-symbol candidate
 * universe with SPY completed-bar benchmark. Entry pricing anchors to completed 1m bar
 * closes (±10 bps limit) so wide single-exchange IEX quotes do not distort NBBO execution.
 */
export const intradayAlphaEquityMarketProfile = Object.freeze({
  ...retainedEquityMarketProfile,
  market: MarketKind.Equity,
  universeId: currentEquityUniverse.id,
  universeSymbolHash: currentEquityUniverse.symbolHash,
  universe: currentEquityUniverse.symbols,
  candidateSymbols: intradayAlphaCandidateSymbols,
  benchmarkEvidencePolicy: IntradayBenchmarkEvidencePolicy.CompletedBars,
})

/**
 * Three-engine disjoint concurrent multi-sleeve intraday alpha policy (bayn.intraday-alpha-policy.v2):
 *  - Engine 1 (Morning ATR-Scaled ORB30): 18 single-name equities, 10:00–10:50 ET, 0.35×ATR14 stop / 2R target, inv-ATR sizing.
 *  - Engine 2 (Midday Relative-VWAP Reversion): 18 single-name equities, 11:30–12:00 ET, sign-gated 2L/2S dollar-neutral, flatten 15:55 ET.
 *  - Engine 3 (Zarattini-Aziz-Barbon Noise Area Momentum): QQQ & SMH exclusively, 10:00–15:00 ET 30m grid, 1.5×ATR14 stop, flatten 15:58 ET.
 */
export const intradayAlphaDefinition = Object.freeze({
  entryLimitSlippageBps: 10,
  maximumPositions: 4,
  maximumGrossWeight: 0.8,
  maximumSymbolWeight: 0.35,
  maximumHoldingMinutes: 390,
  trailingBaseline: Object.freeze({
    lookbackSessions: 14,
    minimumSessions: 5,
  }),
  morningOrb: Object.freeze({
    openingRangeMinutes: 30,
    minimumOpeningRangeBars: 27,
    minimumRecent15MinBars: 13,
    entryStartMinuteFromOpen: 30,
    entryEndMinuteFromOpen: 80,
    maximumHoldingMinutes: 60,
    hardExitMinuteFromOpen: 118,
    stopAtrMultiple: 0.35,
    minimumStopBps: 50,
    maximumStopBps: 300,
    rewardRiskMultiple: 2,
    riskBudgetBps: 50,
    maximumWeightPerLeg: 0.35,
    maximumPositions: 1,
    maxTradesPerSession: 1,
    requireOpeningCandleDirection: true,
  }),
  middayReversion: Object.freeze({
    entryStartMinuteFromOpen: 120,
    entryEndMinuteFromOpen: 150,
    minimumSessionBars: 90,
    minimumRecent15MinBars: 13,
    targetPairs: 2,
    maximumPositions: 4,
    targetWeightPerLeg: 0.18,
    fallbackSingleLegWeight: 0.2,
    protectiveStopBps: 500,
    profitTargetBps: 800,
    flattenMinuteFromOpen: 385,
    requireOppositeSigns: true,
  }),
  noiseArea: Object.freeze({
    checkpointMinutesFromOpen: noiseAreaCheckpointMinutes,
    minimumRecent15MinBars: 13,
    sleeveGrossWeight: 0.5,
    minimumWeightPerLeg: 0.15,
    maximumWeightPerLeg: 0.32,
    stopAtrMultiple: 1.5,
    minimumStopBps: 150,
    maximumStopBps: 600,
    profitTargetBps: 1500,
    flattenMinuteFromOpen: 388,
    maxEntriesPerSymbolPerSession: 1,
  }),
  catalystVeto: Object.freeze({
    enabled: false,
    model: jevModel,
    vetoThreshold: 0.85,
    maxCandidatesPerSide: 4,
  }),
})

export const intradayAlphaPromptPolicy = Object.freeze({
  schemaVersion: 'bayn.intraday-alpha-prompts.v1',
  model: intradayAlphaDefinition.catalystVeto.model,
  vetoQuestionName: 'catalyst_dislocation_veto',
  vetoThreshold: intradayAlphaDefinition.catalystVeto.vetoThreshold,
  instructions:
    'Evaluate only the supplied completed one-minute bars and session context for this symbol. Return high probability (>= 0.85) ONLY if the price and volume sequence shows an unambiguous disorderly news, earnings, or trading-halt one-way dislocation that invalidates normal intraday structure. Normal intraday volatility, routine pullbacks, or ordinary sector dispersion must NOT be vetoed.',
})

export const intradayAlphaPromptsHash = () => canonicalHashV1Result(intradayAlphaPromptPolicy)

export const IntradayAlphaPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-policy.v2'),
  sharedProtocol: JevProtocolSchema,
  candidateSymbols: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  equitySymbols: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  noiseAreaSymbols: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  benchmarkSymbol: Schema.Literal(intradayAlphaBenchmarkSymbol),
  entryLimitSlippageBps: Schema.Literal(intradayAlphaDefinition.entryLimitSlippageBps),
  maximumPositions: Schema.Literal(intradayAlphaDefinition.maximumPositions),
  maximumGrossWeight: Schema.Literal(intradayAlphaDefinition.maximumGrossWeight),
  maximumSymbolWeight: Schema.Literal(intradayAlphaDefinition.maximumSymbolWeight),
  maximumHoldingMinutes: Schema.Literal(intradayAlphaDefinition.maximumHoldingMinutes),
  trailingBaseline: Schema.Struct({
    lookbackSessions: Schema.Literal(intradayAlphaDefinition.trailingBaseline.lookbackSessions),
    minimumSessions: Schema.Literal(intradayAlphaDefinition.trailingBaseline.minimumSessions),
  }),
  morningOrb: Schema.Struct({
    openingRangeMinutes: Schema.Literal(intradayAlphaDefinition.morningOrb.openingRangeMinutes),
    minimumOpeningRangeBars: Schema.Literal(intradayAlphaDefinition.morningOrb.minimumOpeningRangeBars),
    minimumRecent15MinBars: Schema.Literal(intradayAlphaDefinition.morningOrb.minimumRecent15MinBars),
    entryStartMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.morningOrb.entryStartMinuteFromOpen),
    entryEndMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.morningOrb.entryEndMinuteFromOpen),
    maximumHoldingMinutes: Schema.Literal(intradayAlphaDefinition.morningOrb.maximumHoldingMinutes),
    hardExitMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.morningOrb.hardExitMinuteFromOpen),
    stopAtrMultiple: Schema.Literal(intradayAlphaDefinition.morningOrb.stopAtrMultiple),
    minimumStopBps: Schema.Literal(intradayAlphaDefinition.morningOrb.minimumStopBps),
    maximumStopBps: Schema.Literal(intradayAlphaDefinition.morningOrb.maximumStopBps),
    rewardRiskMultiple: Schema.Literal(intradayAlphaDefinition.morningOrb.rewardRiskMultiple),
    riskBudgetBps: Schema.Literal(intradayAlphaDefinition.morningOrb.riskBudgetBps),
    maximumWeightPerLeg: Schema.Literal(intradayAlphaDefinition.morningOrb.maximumWeightPerLeg),
    maximumPositions: Schema.Literal(intradayAlphaDefinition.morningOrb.maximumPositions),
    maxTradesPerSession: Schema.Literal(intradayAlphaDefinition.morningOrb.maxTradesPerSession),
    requireOpeningCandleDirection: Schema.Literal(intradayAlphaDefinition.morningOrb.requireOpeningCandleDirection),
  }),
  middayReversion: Schema.Struct({
    entryStartMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.middayReversion.entryStartMinuteFromOpen),
    entryEndMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.middayReversion.entryEndMinuteFromOpen),
    minimumSessionBars: Schema.Literal(intradayAlphaDefinition.middayReversion.minimumSessionBars),
    minimumRecent15MinBars: Schema.Literal(intradayAlphaDefinition.middayReversion.minimumRecent15MinBars),
    targetPairs: Schema.Literal(intradayAlphaDefinition.middayReversion.targetPairs),
    maximumPositions: Schema.Literal(intradayAlphaDefinition.middayReversion.maximumPositions),
    targetWeightPerLeg: Schema.Literal(intradayAlphaDefinition.middayReversion.targetWeightPerLeg),
    fallbackSingleLegWeight: Schema.Literal(intradayAlphaDefinition.middayReversion.fallbackSingleLegWeight),
    protectiveStopBps: Schema.Literal(intradayAlphaDefinition.middayReversion.protectiveStopBps),
    profitTargetBps: Schema.Literal(intradayAlphaDefinition.middayReversion.profitTargetBps),
    flattenMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.middayReversion.flattenMinuteFromOpen),
    requireOppositeSigns: Schema.Literal(intradayAlphaDefinition.middayReversion.requireOppositeSigns),
  }),
  noiseArea: Schema.Struct({
    checkpointMinutesFromOpen: Schema.Array(Schema.Int),
    minimumRecent15MinBars: Schema.Literal(intradayAlphaDefinition.noiseArea.minimumRecent15MinBars),
    sleeveGrossWeight: Schema.Literal(intradayAlphaDefinition.noiseArea.sleeveGrossWeight),
    minimumWeightPerLeg: Schema.Literal(intradayAlphaDefinition.noiseArea.minimumWeightPerLeg),
    maximumWeightPerLeg: Schema.Literal(intradayAlphaDefinition.noiseArea.maximumWeightPerLeg),
    stopAtrMultiple: Schema.Literal(intradayAlphaDefinition.noiseArea.stopAtrMultiple),
    minimumStopBps: Schema.Literal(intradayAlphaDefinition.noiseArea.minimumStopBps),
    maximumStopBps: Schema.Literal(intradayAlphaDefinition.noiseArea.maximumStopBps),
    profitTargetBps: Schema.Literal(intradayAlphaDefinition.noiseArea.profitTargetBps),
    flattenMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.noiseArea.flattenMinuteFromOpen),
    maxEntriesPerSymbolPerSession: Schema.Literal(intradayAlphaDefinition.noiseArea.maxEntriesPerSymbolPerSession),
  }),
  catalystVeto: Schema.Struct({
    enabled: Schema.Literal(intradayAlphaDefinition.catalystVeto.enabled),
    model: Schema.Literal(intradayAlphaDefinition.catalystVeto.model),
    vetoThreshold: Schema.Literal(intradayAlphaDefinition.catalystVeto.vetoThreshold),
    maxCandidatesPerSide: Schema.Literal(intradayAlphaDefinition.catalystVeto.maxCandidatesPerSide),
  }),
}).check(
  Schema.makeFilter((policy) => {
    const issues: Schema.FilterIssue[] = []
    if (policy.candidateSymbols.join(',') !== intradayAlphaCandidateSymbols.join(',')) {
      issues.push({
        path: ['candidateSymbols'],
        issue: 'must bind the exact reviewed 20-symbol intraday alpha universe',
      })
    }
    if (policy.equitySymbols.join(',') !== intradayAlphaEquitySymbols.join(',')) {
      issues.push({
        path: ['equitySymbols'],
        issue: 'must bind the exact 18 single-name equity symbols disjoint from noise-area ETFs',
      })
    }
    if (policy.noiseAreaSymbols.join(',') !== intradayAlphaNoiseAreaSymbols.join(',')) {
      issues.push({
        path: ['noiseAreaSymbols'],
        issue: 'must bind the exact reviewed QQQ,SMH noise-area sleeve symbols',
      })
    }
    if (policy.noiseArea.checkpointMinutesFromOpen.join(',') !== noiseAreaCheckpointMinutes.join(',')) {
      issues.push({
        path: ['noiseArea', 'checkpointMinutesFromOpen'],
        issue: 'must bind the exact 30-minute noise-area checkpoint grid',
      })
    }
    return issues
  }),
)
export type IntradayAlphaPolicy = typeof IntradayAlphaPolicySchema.Type
export type IntradayAlphaPolicyMaterial = Omit<IntradayAlphaPolicy, 'sharedProtocol'> & {
  readonly sharedProtocol: JevProtocolMaterial
}

export const intradayAlphaBehaviorHash = sha256('bayn.intraday-alpha.behavior.v3')

export const makeIntradayAlphaPolicy = <P extends JevProtocolMaterial>(
  sharedProtocol: P,
): Omit<IntradayAlphaPolicy, 'sharedProtocol'> & { readonly sharedProtocol: P } => ({
  schemaVersion: 'bayn.intraday-alpha-policy.v2',
  sharedProtocol,
  candidateSymbols: [...intradayAlphaCandidateSymbols],
  equitySymbols: [...intradayAlphaEquitySymbols],
  noiseAreaSymbols: [...intradayAlphaNoiseAreaSymbols],
  benchmarkSymbol: intradayAlphaBenchmarkSymbol,
  entryLimitSlippageBps: intradayAlphaDefinition.entryLimitSlippageBps,
  maximumPositions: intradayAlphaDefinition.maximumPositions,
  maximumGrossWeight: intradayAlphaDefinition.maximumGrossWeight,
  maximumSymbolWeight: intradayAlphaDefinition.maximumSymbolWeight,
  maximumHoldingMinutes: intradayAlphaDefinition.maximumHoldingMinutes,
  trailingBaseline: { ...intradayAlphaDefinition.trailingBaseline },
  morningOrb: { ...intradayAlphaDefinition.morningOrb },
  middayReversion: { ...intradayAlphaDefinition.middayReversion },
  noiseArea: {
    ...intradayAlphaDefinition.noiseArea,
    checkpointMinutesFromOpen: [...noiseAreaCheckpointMinutes],
  },
  catalystVeto: { ...intradayAlphaDefinition.catalystVeto },
})

export const decodeIntradayAlphaPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    IntradayAlphaPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Intraday alpha policy is invalid', cause })),
  )

export const intradayAlphaStrategyIdentity = (policy: IntradayAlphaPolicyMaterial) =>
  Result.gen(function* () {
    const strategy = {
      name: 'jev' as const,
      behaviorHash: intradayAlphaBehaviorHash,
      parameterHash: yield* canonicalHashV1Result(policy),
      parameterSchemaVersion: policy.schemaVersion,
    }
    return { strategy, protocolHash: yield* makeStrategyProtocolHashResult(strategy) }
  })
