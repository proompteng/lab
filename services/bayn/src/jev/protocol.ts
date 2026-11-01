import { MarketKind } from '../instruments'
import { marketHistoryMinutes } from '../market-data/history'
import { JevMarketProfilesSchema, jevMarketProfiles, jevUniverse, jevCandidateSymbols } from './markets'
import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import { Result, Schema } from 'effect'

import { ExecutionModelV6Schema } from '../execution-model-contract'
import { canonicalHashV1Result, sha256 } from '../hash'
import { maximumIntradayObservationLagMs } from '../market-data/intraday/verification'
import { PositiveIntegerSchema, SymbolSchema, UnitIntervalSchema, strictParseOptions } from '../schemas'
import {
  intradayExecutionModel,
  intradayLookbackMinutes,
  intradayDecisionDelaySeconds,
} from '../strategy/intraday-market'
import { JevContractError, jevModel } from './contract'
import { stagedChartQuestionPolicy } from './staged-chart-questions'
import { stagedChartQuestionPolicy as retainedFilteredChartQuestionPolicy } from './retained-filtered-staged-chart-questions'
import { entryJudgmentPolicy } from './entry-questions'
import { retainedMarketEntryJudgmentPolicy } from './retained-market-entry-questions'

const entryQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: stagedChartQuestionPolicy, jev: entryJudgmentPolicy }),
)
const retainedMarketQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: retainedFilteredChartQuestionPolicy, jev: retainedMarketEntryJudgmentPolicy }),
)

const Minutes = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60))
const Weight = UnitIntervalSchema.check(Schema.isGreaterThan(0))

const protocolFields = (entryQuestionPolicyHash: string) => ({
  entrySizingPolicy: Schema.Literal('capital-weighted-session-limit'),
  entryFeePolicy: Schema.Literal('broker-tier-buy-and-maximum-sell'),
  entrySelectionPolicy: Schema.Literal('source-anchored-proposal-judgments'),
  entryQuestionPolicyHash: Schema.Literal(entryQuestionPolicyHash),
  maximumEntryQuoteDriftBps: Schema.Literal(10),
  maximumEntryLimitSlippageBps: Schema.Literal(10),
  entrySignalPolicy: Schema.Literal('openai-decisions-then-jev'),
  model: Schema.Literal(jevModel),
  marketProfiles: JevMarketProfilesSchema,
  universe: Schema.Array(SymbolSchema),
  candidateSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(18)),
  positionPolicy: Schema.Literal('long-only'),
  decisionDelaySeconds: Schema.Literal(intradayDecisionDelaySeconds),
  maximumDecisionLagMs: PositiveIntegerSchema,
  maximumQuoteAgeMs: Schema.Literal(10_000),
  candidateEvidencePolicy: Schema.optionalKey(Schema.Enum(IntradayCandidateEvidencePolicy)),
  warmupMinutesAfterOpen: Schema.Literal(0),
  entryCutoffMinutesBeforeClose: Schema.Literal(5),
  flattenBeforeCloseMinutes: Schema.Literal(5),
  hardFlatBeforeCloseMinutes: Schema.Literal(0),
  maximumPositions: Schema.Literal(1),
  maximumGrossWeight: Weight,
  maximumSymbolWeight: Weight,
  inferenceValidityMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(10_000)),
  horizonMinutes: Minutes,
  maximumHoldingMinutes: Minutes,
  allocation: Schema.Literal('equal-weight'),
  executionModel: ExecutionModelV6Schema,
})

const CurrentProtocol = Schema.Struct({
  ...protocolFields(entryQuestionPolicyHash),
  inputDefinition: Schema.Literal('bayn.jev-entry-state.v23'),
  schemaVersion: Schema.Literal('bayn.jev.protocol.v35'),
  lookbackMinutes: Schema.Struct({
    equity: Schema.Literal(marketHistoryMinutes[MarketKind.Equity]),
    crypto: Schema.Literal(marketHistoryMinutes[MarketKind.Crypto]),
  }),
})

type ProtocolFields = Omit<typeof CurrentProtocol.Type, 'schemaVersion' | 'lookbackMinutes' | 'inputDefinition'>
const validateProtocol = (
  protocol: ProtocolFields,
  shortestLookbackMinutes: number,
  evidencePolicy?: IntradayCandidateEvidencePolicy,
) => {
  const issues: Schema.FilterIssue[] = []
  if (
    evidencePolicy !== undefined
      ? protocol.candidateEvidencePolicy !== evidencePolicy
      : protocol.candidateEvidencePolicy !== undefined &&
        protocol.candidateEvidencePolicy !== IntradayCandidateEvidencePolicy.QuoteWithWindowTrade
  )
    issues.push({ path: ['candidateEvidencePolicy'], issue: 'must match the protocol evidence contract' })
  if (protocol.universe.join(',') !== jevUniverse.join(','))
    issues.push({ path: ['universe'], issue: 'must match the reviewed equity and crypto universe' })
  const candidates = [...new Set(protocol.candidateSymbols)].sort()
  if (
    candidates.join(',') !== protocol.candidateSymbols.join(',') ||
    candidates.includes('SPY') ||
    candidates.some((symbol) => !protocol.universe.includes(symbol))
  )
    issues.push({
      path: ['candidateSymbols'],
      issue: 'must be unique sorted universe members excluding the benchmark',
    })
  if (protocol.maximumSymbolWeight > protocol.maximumGrossWeight)
    issues.push({ path: ['maximumSymbolWeight'], issue: 'cannot exceed the gross allocation' })
  if (protocol.decisionDelaySeconds * 1000 + protocol.maximumDecisionLagMs > maximumIntradayObservationLagMs)
    issues.push({ path: ['maximumDecisionLagMs'], issue: 'must fit the verified observation lag' })
  if (
    protocol.horizonMinutes !== protocol.maximumHoldingMinutes ||
    protocol.maximumHoldingMinutes > shortestLookbackMinutes
  )
    issues.push({
      path: ['horizonMinutes'],
      issue: 'must equal the holding horizon and fit its completed source window',
    })
  const expectedModel = canonicalHashV1Result(intradayExecutionModel)
  const actualModel = canonicalHashV1Result(protocol.executionModel)
  if (Result.isFailure(expectedModel) || Result.isFailure(actualModel) || expectedModel.success !== actualModel.success)
    issues.push({ path: ['executionModel'], issue: 'must preserve the reviewed session-limit execution contract' })
  return issues
}

// These schemas reproduce immutable financial evidence; new execution accepts only v35.
export const jevProtocolSchemaForQuestionPolicy = <
  V extends
    | 'bayn.jev.protocol.v24'
    | 'bayn.jev.protocol.v25'
    | 'bayn.jev.protocol.v26'
    | 'bayn.jev.protocol.v27'
    | 'bayn.jev.protocol.v28'
    | 'bayn.jev.protocol.v29' = 'bayn.jev.protocol.v24',
>(
  entryQuestionPolicyHash: string,
  version: V = 'bayn.jev.protocol.v24' as V,
) =>
  Schema.Struct({
    ...protocolFields(entryQuestionPolicyHash),
    inputDefinition: Schema.Literal('bayn.jev-entry-state.v22'),
    schemaVersion: Schema.Literal(version),
    lookbackMinutes: Schema.Literal(intradayLookbackMinutes),
  }).check(
    Schema.makeFilter((protocol) =>
      validateProtocol(
        protocol,
        protocol.lookbackMinutes,
        version === 'bayn.jev.protocol.v29' ? IntradayCandidateEvidencePolicy.MarketQuotes : undefined,
      ),
    ),
  )

export const JevProtocolSchema = CurrentProtocol.check(
  Schema.makeFilter((protocol) =>
    validateProtocol(
      protocol,
      Math.min(protocol.lookbackMinutes.equity, protocol.lookbackMinutes.crypto),
      IntradayCandidateEvidencePolicy.MarketQuotesV2,
    ),
  ),
)

export const RetainedJevProtocolV30Schema = Schema.Struct({
  ...CurrentProtocol.fields,
  inputDefinition: Schema.Literal('bayn.jev-entry-state.v22'),
  ...protocolFields(retainedMarketQuestionPolicyHash),
  schemaVersion: Schema.Literal('bayn.jev.protocol.v30'),
}).check(
  Schema.makeFilter((protocol) =>
    validateProtocol(
      protocol,
      Math.min(protocol.lookbackMinutes.equity, protocol.lookbackMinutes.crypto),
      IntradayCandidateEvidencePolicy.MarketQuotes,
    ),
  ),
)

export const RetainedJevProtocolV31Schema = Schema.Struct({
  ...CurrentProtocol.fields,
  inputDefinition: Schema.Literal('bayn.jev-entry-state.v22'),
  ...protocolFields(retainedMarketQuestionPolicyHash),
  schemaVersion: Schema.Literal('bayn.jev.protocol.v31'),
}).check(
  Schema.makeFilter((protocol) =>
    validateProtocol(
      protocol,
      Math.min(protocol.lookbackMinutes.equity, protocol.lookbackMinutes.crypto),
      IntradayCandidateEvidencePolicy.MarketQuotesV2,
    ),
  ),
)

export const RetainedJevProtocolV32Schema = Schema.Struct({
  ...CurrentProtocol.fields,
  inputDefinition: Schema.Literal('bayn.jev-entry-state.v22'),
  ...protocolFields('c6c8032291a3840de13db71ca02aaf8149b8d862e425cc24fdc5327b47cd3c03'),
  schemaVersion: Schema.Literal('bayn.jev.protocol.v32'),
}).check(
  Schema.makeFilter((protocol) =>
    validateProtocol(
      protocol,
      Math.min(protocol.lookbackMinutes.equity, protocol.lookbackMinutes.crypto),
      IntradayCandidateEvidencePolicy.MarketQuotesV2,
    ),
  ),
)

export const RetainedJevProtocolV33Schema = Schema.Struct({
  ...CurrentProtocol.fields,
  ...protocolFields('864658b2565a176ecad7e6e2460a9f9be9340bf9f304d5af41db81ce49551158'),
  inputDefinition: Schema.Literal('bayn.jev-entry-state.v22'),
  schemaVersion: Schema.Literal('bayn.jev.protocol.v33'),
}).check(
  Schema.makeFilter((protocol) =>
    validateProtocol(
      protocol,
      Math.min(protocol.lookbackMinutes.equity, protocol.lookbackMinutes.crypto),
      IntradayCandidateEvidencePolicy.MarketQuotesV2,
    ),
  ),
)

export const RetainedJevProtocolV34Schema = Schema.Struct({
  ...CurrentProtocol.fields,
  ...protocolFields('864658b2565a176ecad7e6e2460a9f9be9340bf9f304d5af41db81ce49551158'),
  schemaVersion: Schema.Literal('bayn.jev.protocol.v34'),
}).check(
  Schema.makeFilter((protocol) =>
    validateProtocol(
      protocol,
      Math.min(protocol.lookbackMinutes.equity, protocol.lookbackMinutes.crypto),
      IntradayCandidateEvidencePolicy.MarketQuotesV2,
    ),
  ),
)

export type JevProtocol = typeof JevProtocolSchema.Type
export type JevProtocolMaterial =
  | JevProtocol
  | typeof RetainedJevProtocolV30Schema.Type
  | typeof RetainedJevProtocolV31Schema.Type
  | typeof RetainedJevProtocolV32Schema.Type
  | typeof RetainedJevProtocolV33Schema.Type
  | typeof RetainedJevProtocolV34Schema.Type
  | (Omit<JevProtocol, 'schemaVersion' | 'lookbackMinutes' | 'inputDefinition'> & {
      readonly inputDefinition: 'bayn.jev-entry-state.v22'
      readonly lookbackMinutes: 30
      readonly schemaVersion:
        | 'bayn.jev.protocol.v24'
        | 'bayn.jev.protocol.v25'
        | 'bayn.jev.protocol.v26'
        | 'bayn.jev.protocol.v27'
        | 'bayn.jev.protocol.v28'
        | 'bayn.jev.protocol.v29'
    })

export const defaultJevProtocolDocument = Object.freeze({
  schemaVersion: 'bayn.jev.protocol.v35',
  entrySizingPolicy: 'capital-weighted-session-limit',
  entryFeePolicy: 'broker-tier-buy-and-maximum-sell',
  entrySelectionPolicy: 'source-anchored-proposal-judgments',
  entryQuestionPolicyHash,
  maximumEntryQuoteDriftBps: 10,
  maximumEntryLimitSlippageBps: 10,
  entrySignalPolicy: 'openai-decisions-then-jev',
  model: jevModel,
  inputDefinition: 'bayn.jev-entry-state.v23',
  marketProfiles: jevMarketProfiles,
  universe: jevUniverse,
  candidateSymbols: jevCandidateSymbols,
  positionPolicy: 'long-only',
  lookbackMinutes: Object.freeze({
    equity: marketHistoryMinutes[MarketKind.Equity],
    crypto: marketHistoryMinutes[MarketKind.Crypto],
  }),
  decisionDelaySeconds: intradayDecisionDelaySeconds,
  maximumDecisionLagMs: 60_000,
  maximumQuoteAgeMs: 10_000,
  candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotesV2,
  warmupMinutesAfterOpen: 0,
  entryCutoffMinutesBeforeClose: 5,
  flattenBeforeCloseMinutes: 5,
  hardFlatBeforeCloseMinutes: 0,
  maximumPositions: 1,
  maximumGrossWeight: 0.2,
  maximumSymbolWeight: 0.2,
  inferenceValidityMs: 10_000,
  horizonMinutes: 15,
  maximumHoldingMinutes: 15,
  allocation: 'equal-weight',
  executionModel: intradayExecutionModel,
} as const)

export const decodeJevProtocol = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevProtocolSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev strategy protocol is invalid', cause })),
  )

export const jevBehaviorHash = sha256('bayn.candidate-chart-entry.behavior.v1')
