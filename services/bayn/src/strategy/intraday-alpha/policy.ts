import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../../contracts'
import { canonicalHashV1Result, sha256 } from '../../hash'
import { MarketKind } from '../../instruments'
import { JevContractError, jevModel } from '../../jev/contract'
import { retainedEquityMarketProfile } from '../../jev/markets'
import { JevProtocolSchema, type JevProtocolMaterial } from '../../jev/protocol'
import { IntradayBenchmarkEvidencePolicy } from '../../market-data/intraday/model'
import { strictParseOptions } from '../../schemas'
import { currentEquityUniverse } from '../intraday-market'
import {
  IntradayAlphaPhase,
  IntradayAlphaSetup,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
} from './constants'

export { IntradayAlphaPhase, IntradayAlphaSetup, intradayAlphaBenchmarkSymbol, intradayAlphaCandidateSymbols }

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

export const intradayAlphaDefinition = Object.freeze({
  entryLimitSlippageBps: 10,
  maximumPositions: 4,
  maximumGrossWeight: 0.8,
  maximumSymbolWeight: 0.2,
  maximumHoldingMinutes: 390,
  morningOrb: Object.freeze({
    openingRangeMinutes: 30,
    minimumOpeningRangeBars: 27,
    minimumRecent15MinBars: 13,
    entryStartMinuteFromOpen: 30,
    entryEndMinuteFromOpen: 80,
    maximumHoldingMinutes: 60,
    hardExitMinuteFromOpen: 118,
    protectiveStopBps: 100,
    profitTargetBps: 200,
    maximumPositions: 1,
    maxTradesPerSession: 2,
    targetWeightPerLeg: 0.2,
    requireOpeningCandleDirection: true,
  }),
  middayReversion: Object.freeze({
    entryStartMinuteFromOpen: 120,
    entryEndMinuteFromOpen: 150,
    minimumSessionBars: 90,
    minimumRecent15MinBars: 13,
    targetPairs: 2,
    maximumPositions: 4,
    // 2 * 0.18 Long (36%) + 2 * 0.18 * 1.5 Short collateral (54%) = 90% max buying power.
    // Fits safely inside both 1x cash-only and 2x margin accounts without InsufficientBuyingPower.
    targetWeightPerLeg: 0.18,
    fallbackSingleLegWeight: 0.2,
    protectiveStopBps: 500,
    profitTargetBps: 800,
    flattenMinuteFromOpen: 385,
  }),
  catalystVeto: Object.freeze({
    // Deterministic peer-reviewed alpha runs without live Jev API calls until catalyst inference is
    // routed through durable inference expense journaling.
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
  schemaVersion: Schema.Literal('bayn.intraday-alpha-policy.v1'),
  sharedProtocol: JevProtocolSchema,
  candidateSymbols: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  benchmarkSymbol: Schema.Literal(intradayAlphaBenchmarkSymbol),
  entryLimitSlippageBps: Schema.Literal(intradayAlphaDefinition.entryLimitSlippageBps),
  maximumPositions: Schema.Literal(intradayAlphaDefinition.maximumPositions),
  maximumGrossWeight: Schema.Literal(intradayAlphaDefinition.maximumGrossWeight),
  maximumSymbolWeight: Schema.Literal(intradayAlphaDefinition.maximumSymbolWeight),
  maximumHoldingMinutes: Schema.Literal(intradayAlphaDefinition.maximumHoldingMinutes),
  morningOrb: Schema.Struct({
    openingRangeMinutes: Schema.Literal(intradayAlphaDefinition.morningOrb.openingRangeMinutes),
    minimumOpeningRangeBars: Schema.Literal(intradayAlphaDefinition.morningOrb.minimumOpeningRangeBars),
    minimumRecent15MinBars: Schema.Literal(intradayAlphaDefinition.morningOrb.minimumRecent15MinBars),
    entryStartMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.morningOrb.entryStartMinuteFromOpen),
    entryEndMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.morningOrb.entryEndMinuteFromOpen),
    maximumHoldingMinutes: Schema.Literal(intradayAlphaDefinition.morningOrb.maximumHoldingMinutes),
    hardExitMinuteFromOpen: Schema.Literal(intradayAlphaDefinition.morningOrb.hardExitMinuteFromOpen),
    protectiveStopBps: Schema.Literal(intradayAlphaDefinition.morningOrb.protectiveStopBps),
    profitTargetBps: Schema.Literal(intradayAlphaDefinition.morningOrb.profitTargetBps),
    maximumPositions: Schema.Literal(intradayAlphaDefinition.morningOrb.maximumPositions),
    maxTradesPerSession: Schema.Literal(intradayAlphaDefinition.morningOrb.maxTradesPerSession),
    targetWeightPerLeg: Schema.Literal(intradayAlphaDefinition.morningOrb.targetWeightPerLeg),
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
  }),
  catalystVeto: Schema.Struct({
    enabled: Schema.Literal(intradayAlphaDefinition.catalystVeto.enabled),
    model: Schema.Literal(intradayAlphaDefinition.catalystVeto.model),
    vetoThreshold: Schema.Literal(intradayAlphaDefinition.catalystVeto.vetoThreshold),
    maxCandidatesPerSide: Schema.Literal(intradayAlphaDefinition.catalystVeto.maxCandidatesPerSide),
  }),
}).check(
  Schema.makeFilter((policy) =>
    policy.candidateSymbols.join(',') === intradayAlphaCandidateSymbols.join(',')
      ? []
      : [{ path: ['candidateSymbols'], issue: 'must bind the exact reviewed 20-symbol intraday alpha universe' }],
  ),
)
export type IntradayAlphaPolicy = typeof IntradayAlphaPolicySchema.Type
export type IntradayAlphaPolicyMaterial = Omit<IntradayAlphaPolicy, 'sharedProtocol'> & {
  readonly sharedProtocol: JevProtocolMaterial
}

export const intradayAlphaBehaviorHash = sha256('bayn.intraday-alpha.behavior.v2')

export const makeIntradayAlphaPolicy = <P extends JevProtocolMaterial>(
  sharedProtocol: P,
): Omit<IntradayAlphaPolicy, 'sharedProtocol'> & { readonly sharedProtocol: P } => ({
  schemaVersion: 'bayn.intraday-alpha-policy.v1',
  sharedProtocol,
  candidateSymbols: [...intradayAlphaCandidateSymbols],
  benchmarkSymbol: intradayAlphaBenchmarkSymbol,
  entryLimitSlippageBps: intradayAlphaDefinition.entryLimitSlippageBps,
  maximumPositions: intradayAlphaDefinition.maximumPositions,
  maximumGrossWeight: intradayAlphaDefinition.maximumGrossWeight,
  maximumSymbolWeight: intradayAlphaDefinition.maximumSymbolWeight,
  maximumHoldingMinutes: intradayAlphaDefinition.maximumHoldingMinutes,
  morningOrb: { ...intradayAlphaDefinition.morningOrb },
  middayReversion: { ...intradayAlphaDefinition.middayReversion },
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
