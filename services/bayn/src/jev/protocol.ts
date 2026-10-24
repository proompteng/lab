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

const Minutes = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60))
const Weight = UnitIntervalSchema.check(Schema.isGreaterThan(0))

const ProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev.protocol.v22'),
  entrySizingPolicy: Schema.Literal('capital-weighted-session-limit'),
  entrySelectionPolicy: Schema.Literal('supported-setup-and-economic-plan'),
  maximumEntryQuoteDriftBps: Schema.Literal(10),
  maximumEntryLimitSlippageBps: Schema.Literal(10),
  entrySignalPolicy: Schema.Literal('model-selected-entry-and-protection'),
  model: Schema.Literal(jevModel),
  inputDefinition: Schema.Literal('bayn.jev-trading-signal-state.v20'),
  marketProfiles: JevMarketProfilesSchema,
  universe: Schema.Array(SymbolSchema),
  candidateSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(18)),
  positionPolicy: Schema.Literal('long-only'),
  lookbackMinutes: Schema.Literal(intradayLookbackMinutes),
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

export const JevProtocolSchema = ProtocolBase.check(
  Schema.makeFilter((protocol) => {
    const issues: Schema.FilterIssue[] = []
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
      protocol.maximumHoldingMinutes > protocol.lookbackMinutes
    )
      issues.push({
        path: ['horizonMinutes'],
        issue: 'must equal the holding horizon and fit its completed source window',
      })
    const expectedModel = canonicalHashV1Result(intradayExecutionModel)
    const actualModel = canonicalHashV1Result(protocol.executionModel)
    if (
      Result.isFailure(expectedModel) ||
      Result.isFailure(actualModel) ||
      expectedModel.success !== actualModel.success
    )
      issues.push({ path: ['executionModel'], issue: 'must preserve the reviewed session-limit execution contract' })
    return issues
  }),
)

export type JevProtocol = typeof JevProtocolSchema.Type

export const defaultJevProtocolDocument = Object.freeze({
  schemaVersion: 'bayn.jev.protocol.v22',
  entrySizingPolicy: 'capital-weighted-session-limit',
  entrySelectionPolicy: 'supported-setup-and-economic-plan',
  maximumEntryQuoteDriftBps: 10,
  maximumEntryLimitSlippageBps: 10,
  entrySignalPolicy: 'model-selected-entry-and-protection',
  model: jevModel,
  inputDefinition: 'bayn.jev-trading-signal-state.v20',
  marketProfiles: jevMarketProfiles,
  universe: jevUniverse,
  candidateSymbols: jevCandidateSymbols,
  positionPolicy: 'long-only',
  lookbackMinutes: intradayLookbackMinutes,
  decisionDelaySeconds: intradayDecisionDelaySeconds,
  maximumDecisionLagMs: 60_000,
  maximumQuoteAgeMs: 10_000,
  candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
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

export const jevBehaviorHash = sha256('bayn.jev.executable-profit-limit.behavior.v1')
