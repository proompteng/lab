import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import { Result, Schema } from 'effect'

import { ExecutionModelV5Schema } from '../execution-model-contract'
import { canonicalHashV1Result, sha256 } from '../hash'
import { maximumIntradayObservationLagMs } from '../market-data/intraday/verification'
import { PositiveIntegerSchema, SymbolSchema, UnitIntervalSchema, strictParseOptions } from '../schemas'
import {
  intradayExecutionModel,
  intradaySourceTopics,
  intradayStreamingContract,
  IntradayStreamingInputSchema,
  intradayUniverse,
} from '../strategy/intraday-market'
import { JevContractError, jevModel } from './contract'

const Minutes = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60))
const Probability = UnitIntervalSchema.check(Schema.isGreaterThan(0.5))
const Weight = UnitIntervalSchema.check(Schema.isGreaterThan(0))

const ProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev.protocol.v1'),
  model: Schema.Literal(jevModel),
  inputDefinition: Schema.Literal('bayn.jev-trading-signal-state.v2'),
  streamingInput: IntradayStreamingInputSchema,
  universeId: Schema.Literal(intradayUniverse.id),
  universeSymbolHash: Schema.Literal(intradayUniverse.symbolHash),
  universe: Schema.Array(SymbolSchema),
  candidateSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(15)),
  benchmarkSymbol: Schema.Literal('SPY'),
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  sourceTopics: Schema.Struct({
    bars: Schema.Literal(intradaySourceTopics.bars),
    quotes: Schema.Literal(intradaySourceTopics.quotes),
    trades: Schema.Literal(intradaySourceTopics.trades),
  }),
  positionPolicy: Schema.Literal('long-only'),
  lookbackMinutes: Schema.Literal(30),
  decisionDelaySeconds: Schema.Literal(2),
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
  maximumSpreadBps: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(100)),
  inferenceValidityMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(10_000)),
  horizonMinutes: Minutes,
  maximumHoldingMinutes: Minutes,
  protectiveStopBps: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(500)),
  minimumEntryProbability: Probability,
  minimumExitProbability: Probability,
  allocation: Schema.Literal('equal-weight'),
  executionModel: ExecutionModelV5Schema,
})

export const JevProtocolSchema = ProtocolBase.check(
  Schema.makeFilter((protocol) => {
    const issues: Schema.FilterIssue[] = []
    if (protocol.universe.join(',') !== intradayUniverse.symbols.join(','))
      issues.push({ path: ['universe'], issue: 'must match the source-controlled market-data universe' })
    const candidates = [...new Set(protocol.candidateSymbols)].sort()
    if (
      candidates.join(',') !== protocol.candidateSymbols.join(',') ||
      candidates.includes(protocol.benchmarkSymbol) ||
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
    if (protocol.horizonMinutes > protocol.maximumHoldingMinutes)
      issues.push({ path: ['horizonMinutes'], issue: 'cannot exceed the position holding limit' })
    const expectedModel = canonicalHashV1Result(intradayExecutionModel)
    const actualModel = canonicalHashV1Result(protocol.executionModel)
    if (
      Result.isFailure(expectedModel) ||
      Result.isFailure(actualModel) ||
      expectedModel.success !== actualModel.success
    )
      issues.push({ path: ['executionModel'], issue: 'must preserve the reviewed LIMIT/IOC execution contract' })
    return issues
  }),
)

export type JevProtocol = typeof JevProtocolSchema.Type

export const defaultJevProtocolDocument = Object.freeze({
  schemaVersion: 'bayn.jev.protocol.v1',
  model: jevModel,
  inputDefinition: 'bayn.jev-trading-signal-state.v2',
  streamingInput: intradayStreamingContract,
  universeId: intradayUniverse.id,
  universeSymbolHash: intradayUniverse.symbolHash,
  universe: intradayUniverse.symbols,
  candidateSymbols: intradayUniverse.symbols.filter((symbol) => symbol !== 'SPY'),
  benchmarkSymbol: 'SPY',
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  sourceTopics: intradaySourceTopics,
  positionPolicy: 'long-only',
  lookbackMinutes: 30,
  decisionDelaySeconds: 2,
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
  maximumSpreadBps: 5,
  inferenceValidityMs: 10_000,
  horizonMinutes: 15,
  maximumHoldingMinutes: 15,
  protectiveStopBps: 50,
  minimumEntryProbability: 0.65,
  minimumExitProbability: 0.65,
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

export const jevBehaviorHash = sha256('bayn.jev.behavior.v3')
export const jevSnapshotSymbols = (protocol: JevProtocol, candidates = protocol.candidateSymbols): readonly string[] =>
  [...candidates, protocol.benchmarkSymbol].sort()
