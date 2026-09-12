import { Data, Result, Schema } from 'effect'
import {
  MarketFeatureContract,
  MarketFeatureDefinition,
  marketFeatureClockSkewAllowanceMs,
  rollingFeatureDefinitionMaterial,
} from '../../market-data/features/contract'
import { kafkaBootstrapDeadlineMs, KafkaBootstrapTimestampPolicy } from '../../market-data/streaming/bootstrap'

import {
  ExecutionModelV5Schema,
  usEquityRegularSessionDurationMs,
  type ExecutionModel,
} from '../../execution-model-contract'
import { canonicalHashV1Result, sha256, type CanonicalHashFailure } from '../../hash'
import {
  maximumIntradayObservationLagMs,
  maximumIntradayQuoteAgeMs,
  minimumIntradayQuoteAgeMs,
} from '../../market-data/intraday/verification'
import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SymbolSchema,
  strictParseOptions,
} from '../../schemas'
import { defaultExecutionModel } from '../execution-model/model'

const PositiveUnitIntervalSchema = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const BasisPointsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000))
const PartsPerMillionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000))
const IntradayMinuteOffsetSchema = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(24 * 60))
const SessionBoundaryMinuteOffsetSchema = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(24 * 60))

const coreUniverse = {
  id: 'torghut-core-equity-v2',
  symbols: [
    'AAPL',
    'AMD',
    'AMZN',
    'AVGO',
    'COHR',
    'CRDO',
    'IWM',
    'LITE',
    'MRVL',
    'MU',
    'NVDA',
    'QQQ',
    'SMH',
    'SNDK',
    'SPY',
    'WDC',
  ],
  symbolHash: '12d8e7ad3e0087e85c39f47896e77adde6bb8e029724a70aae1ef5fd393bddf1',
} as const

export const intradayMomentumSourceTopics = Object.freeze({
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
} as const)

export const intradayMomentumCandidateSymbols = ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'] as const
const prospectiveBenchmark = 'SPY' as const

export const intradayMomentumExecutionModel: Extract<
  ExecutionModel,
  { readonly schemaVersion: 'bayn.execution-model.v5' }
> = Object.freeze({
  ...defaultExecutionModel,
  schemaVersion: 'bayn.execution-model.v5',
  order: Object.freeze({
    type: 'limit',
    timeInForce: 'ioc',
    extendedHours: false,
    planAfter: 'verified-intraday-window',
    submitAfter: 'plan-committed',
    submitBefore: 'intraday-entry-cutoff',
    planningPriceReference: 'verified-adverse-top-of-book',
    planningBrokerStateReference: 'reconciled-pre-plan-broker-state',
    fillPriceReference: 'limit-or-better',
    buyingPowerPolicy: 'pre-submit-cash-without-sell-proceeds',
    warmupAfterOpenMs: 0,
    submissionCutoffBeforeCloseMs: 5 * 60_000,
  }),
  precision: Object.freeze({
    ...defaultExecutionModel.precision,
    quantityIncrementMicros: '1000000',
  }),
})

export const intradayMomentumFeatureTopic = 'torghut.market-features.v1' as const
export const intradayMomentumStreamingContract = Object.freeze({
  schemaVersion: 'bayn.streaming-strategy-input.v1',
  snapshotSchemaVersion: 'bayn.streaming-market-snapshot.v1',
  featureTopic: intradayMomentumFeatureTopic,
  featureSchemaVersion: MarketFeatureContract.V1,
  requiredDefinitionId: MarketFeatureDefinition.RollingPrice30m,
  requiredDefinitionHash: sha256(JSON.stringify(rollingFeatureDefinitionMaterial)),
  clockSkewAllowanceMs: marketFeatureClockSkewAllowanceMs,
  bootstrapTimestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  bootstrapDeadlineMs: kafkaBootstrapDeadlineMs,
  freshness: 'exact-completed-window-and-matching-raw-inputs',
} as const)
const StreamingInputContract = Schema.Struct({
  schemaVersion: Schema.Literal(intradayMomentumStreamingContract.schemaVersion),
  snapshotSchemaVersion: Schema.Literal(intradayMomentumStreamingContract.snapshotSchemaVersion),
  featureTopic: Schema.Literal(intradayMomentumFeatureTopic),
  featureSchemaVersion: Schema.Literal(MarketFeatureContract.V1),
  requiredDefinitionId: Schema.Literal(MarketFeatureDefinition.RollingPrice30m),
  requiredDefinitionHash: Schema.Literal(intradayMomentumStreamingContract.requiredDefinitionHash),
  clockSkewAllowanceMs: Schema.Literal(marketFeatureClockSkewAllowanceMs),
  bootstrapTimestampPolicy: Schema.Literal(KafkaBootstrapTimestampPolicy.ProducerClock),
  bootstrapDeadlineMs: Schema.Literal(kafkaBootstrapDeadlineMs),
  freshness: Schema.Literal(intradayMomentumStreamingContract.freshness),
})

const IntradayMomentumProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literals(['bayn.intraday-momentum.protocol.v2', 'bayn.intraday-momentum.protocol.v3']),
  streamingInput: Schema.optionalKey(StreamingInputContract),
  universeId: Schema.Literal('torghut-core-equity-v2'),
  universeSymbolHash: Sha256Schema,
  universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  candidateSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  benchmarkSymbol: SymbolSchema,
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  sourceTopics: Schema.Struct({
    bars: Schema.Literal(intradayMomentumSourceTopics.bars),
    quotes: Schema.Literal(intradayMomentumSourceTopics.quotes),
    trades: Schema.Literal(intradayMomentumSourceTopics.trades),
  }),
  positionPolicy: Schema.Literal('long-only'),
  lookbackMinutes: IntradayMinuteOffsetSchema,
  decisionDelaySeconds: PositiveIntegerSchema,
  maximumDecisionLagMs: PositiveIntegerSchema,
  maximumQuoteAgeMs: PositiveIntegerSchema,
  warmupMinutesAfterOpen: SessionBoundaryMinuteOffsetSchema,
  entryCutoffMinutesBeforeClose: IntradayMinuteOffsetSchema,
  flattenBeforeCloseMinutes: IntradayMinuteOffsetSchema,
  hardFlatBeforeCloseMinutes: SessionBoundaryMinuteOffsetSchema,
  maximumPositions: PositiveIntegerSchema,
  maximumGrossWeight: PositiveUnitIntervalSchema,
  maximumSymbolWeight: PositiveUnitIntervalSchema,
  minimumLookbackReturnBps: BasisPointsSchema,
  minimumBenchmarkReturnBps: Schema.Int.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
  minimumExcessReturnBps: BasisPointsSchema,
  minimumBreakoutBps: BasisPointsSchema,
  minimumRangeLocationPpm: PartsPerMillionSchema,
  maximumSpreadBps: BasisPointsSchema,
  allocation: Schema.Literal('equal-weight'),
  executionModel: ExecutionModelV5Schema,
})

const protocolIssues = (protocol: typeof IntradayMomentumProtocolBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if ((protocol.schemaVersion === 'bayn.intraday-momentum.protocol.v3') !== (protocol.streamingInput !== undefined))
    issues.push({
      path: ['streamingInput'],
      issue: 'v3 requires its streaming input contract; v2 preserves archive inputs',
    })
  if (protocol.streamingInput !== undefined && protocol.lookbackMinutes !== 30)
    issues.push({ path: ['lookbackMinutes'], issue: 'rolling-price-30m requires exactly 30 completed minutes' })
  const canonicalUniverse = [...new Set(protocol.universe)].sort()
  const canonicalCandidates = [...new Set(protocol.candidateSymbols)].sort()
  if (
    canonicalUniverse.length !== protocol.universe.length ||
    canonicalUniverse.some((symbol, index) => symbol !== protocol.universe[index])
  ) {
    issues.push({ path: ['universe'], issue: 'must be unique and sorted in canonical order' })
  }
  if (protocol.universeSymbolHash !== sha256(protocol.universe.join(','))) {
    issues.push({ path: ['universeSymbolHash'], issue: 'must match the canonical universe' })
  }
  if (
    protocol.universeSymbolHash !== coreUniverse.symbolHash ||
    protocol.universe.join(',') !== coreUniverse.symbols.join(',')
  ) {
    issues.push({ path: ['universeId'], issue: 'must bind the exact source-controlled universe' })
  }
  if (
    canonicalCandidates.length !== protocol.candidateSymbols.length ||
    canonicalCandidates.some((symbol, index) => symbol !== protocol.candidateSymbols[index])
  ) {
    issues.push({ path: ['candidateSymbols'], issue: 'must be unique and sorted in canonical order' })
  }
  if (
    protocol.candidateSymbols.join(',') !== intradayMomentumCandidateSymbols.join(',') ||
    protocol.benchmarkSymbol !== prospectiveBenchmark
  ) {
    issues.push({ path: ['candidateSymbols'], issue: 'must bind the immutable prospective trial universe' })
  }
  if (
    protocol.candidateSymbols.some((symbol) => !protocol.universe.includes(symbol)) ||
    !protocol.universe.includes(protocol.benchmarkSymbol) ||
    protocol.candidateSymbols.includes(protocol.benchmarkSymbol)
  ) {
    issues.push({
      path: ['benchmarkSymbol'],
      issue: 'benchmark and candidates must be disjoint members of the universe',
    })
  }
  if (protocol.lookbackMinutes > 30) {
    issues.push({ path: ['lookbackMinutes'], issue: 'must fit the verified bounded intraday archive window' })
  }
  if (protocol.decisionDelaySeconds * 1_000 > maximumIntradayObservationLagMs) {
    issues.push({ path: ['decisionDelaySeconds'], issue: 'must fit the verified post-window observation lag' })
  }
  if (protocol.decisionDelaySeconds * 1_000 + protocol.maximumDecisionLagMs > maximumIntradayObservationLagMs) {
    issues.push({
      path: ['maximumDecisionLagMs'],
      issue: 'must fit the verified post-window observation lag after the decision delay',
    })
  }
  if (
    protocol.maximumQuoteAgeMs < minimumIntradayQuoteAgeMs ||
    protocol.maximumQuoteAgeMs > maximumIntradayQuoteAgeMs
  ) {
    issues.push({ path: ['maximumQuoteAgeMs'], issue: 'must fit the verified quote and trade freshness bounds' })
  }
  if (
    Math.max(protocol.warmupMinutesAfterOpen, protocol.lookbackMinutes) * 60_000 +
      protocol.decisionDelaySeconds * 1_000 +
      protocol.entryCutoffMinutesBeforeClose * 60_000 >=
    usEquityRegularSessionDurationMs
  ) {
    issues.push({ path: ['decisionDelaySeconds'], issue: 'must leave a non-empty regular-session decision interval' })
  }
  if (
    protocol.entryCutoffMinutesBeforeClose < protocol.flattenBeforeCloseMinutes ||
    protocol.flattenBeforeCloseMinutes <= protocol.hardFlatBeforeCloseMinutes
  ) {
    issues.push({
      path: ['entryCutoffMinutesBeforeClose'],
      issue: 'entry cutoff must be at or before flattening, which must precede the hard-flat boundary',
    })
  }
  if (protocol.maximumPositions > protocol.candidateSymbols.length) {
    issues.push({ path: ['maximumPositions'], issue: 'must not exceed the candidate universe size' })
  }
  if (protocol.maximumSymbolWeight > protocol.maximumGrossWeight) {
    issues.push({ path: ['maximumSymbolWeight'], issue: 'must not exceed maximum gross weight' })
  }
  if (
    Math.floor(protocol.maximumSymbolWeight * 1_000_000) < 1 ||
    Math.floor((protocol.maximumGrossWeight * 1_000_000) / protocol.maximumPositions) < 1
  ) {
    issues.push({
      path: ['maximumSymbolWeight'],
      issue: 'must preserve an executable target weight after portfolio rounding',
    })
  }
  if (
    protocol.executionModel.order.warmupAfterOpenMs !== protocol.warmupMinutesAfterOpen * 60_000 ||
    protocol.executionModel.order.submissionCutoffBeforeCloseMs !== protocol.entryCutoffMinutesBeforeClose * 60_000
  ) {
    issues.push({ path: ['executionModel', 'order'], issue: 'must bind the exact rolling decision interval' })
  }
  if (protocol.executionModel.precision.quantityIncrementMicros !== '1000000') {
    issues.push({ path: ['executionModel', 'precision'], issue: 'IOC equity execution requires whole-share sizing' })
  }
  return issues
}

export const IntradayMomentumProtocolSchema = IntradayMomentumProtocolBase.check(Schema.makeFilter(protocolIssues))
export type IntradayMomentumProtocol = typeof IntradayMomentumProtocolSchema.Type

export const intradayMomentumSessionHasDecisionInterval = (
  protocol: IntradayMomentumProtocol,
  session: { readonly openAt: string; readonly closeAt: string },
): boolean => {
  const openAt = Date.parse(session.openAt)
  const closeAt = Date.parse(session.closeAt)
  const earliestDecisionAt =
    openAt +
    Math.max(protocol.warmupMinutesAfterOpen, protocol.lookbackMinutes) * 60_000 +
    protocol.decisionDelaySeconds * 1_000
  const entryCutoffAt = closeAt - protocol.entryCutoffMinutesBeforeClose * 60_000
  return (
    [openAt, closeAt, earliestDecisionAt, entryCutoffAt].every(Number.isSafeInteger) &&
    openAt < closeAt &&
    earliestDecisionAt < entryCutoffAt
  )
}

export const intradayMomentumFirstDecisionPollMs = (
  protocol: IntradayMomentumProtocol,
  window: { readonly executionOpenAt: string; readonly submissionOpenAt: string },
  schedule: { readonly firstPollDelayMs: number; readonly pollIntervalMs: number },
): number => {
  const firstPollMs = Date.parse(window.submissionOpenAt) + schedule.firstPollDelayMs
  const firstRangeEndMs =
    Math.ceil(
      Math.max(
        Date.parse(window.submissionOpenAt),
        Date.parse(window.executionOpenAt) + protocol.lookbackMinutes * 60_000,
      ) / 60_000,
    ) * 60_000
  const readyMs = firstRangeEndMs + protocol.decisionDelaySeconds * 1_000
  return (
    firstPollMs + Math.max(0, Math.ceil((readyMs - firstPollMs) / schedule.pollIntervalMs)) * schedule.pollIntervalMs
  )
}

export const intradayMomentumSnapshotSymbols = (protocol: IntradayMomentumProtocol): readonly string[] =>
  Object.freeze([...protocol.candidateSymbols, protocol.benchmarkSymbol].sort())

export const defaultIntradayMomentumProtocolDocument = Object.freeze({
  schemaVersion: 'bayn.intraday-momentum.protocol.v3',
  streamingInput: intradayMomentumStreamingContract,
  universeId: coreUniverse.id,
  universeSymbolHash: coreUniverse.symbolHash,
  universe: coreUniverse.symbols,
  candidateSymbols: intradayMomentumCandidateSymbols,
  benchmarkSymbol: prospectiveBenchmark,
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  sourceTopics: intradayMomentumSourceTopics,
  positionPolicy: 'long-only',
  lookbackMinutes: 30,
  decisionDelaySeconds: 2,
  maximumDecisionLagMs: 60_000,
  maximumQuoteAgeMs: 10_000,
  warmupMinutesAfterOpen: 0,
  entryCutoffMinutesBeforeClose: 5,
  flattenBeforeCloseMinutes: 5,
  hardFlatBeforeCloseMinutes: 0,
  maximumPositions: 1,
  maximumGrossWeight: 0.1,
  maximumSymbolWeight: 0.1,
  minimumLookbackReturnBps: 15,
  minimumBenchmarkReturnBps: 0,
  minimumExcessReturnBps: 10,
  minimumBreakoutBps: 0,
  minimumRangeLocationPpm: 750_000,
  maximumSpreadBps: 5,
  allocation: 'equal-weight',
  executionModel: intradayMomentumExecutionModel,
} as const)

export class IntradayMomentumProtocolDecodeError extends Data.TaggedError('IntradayMomentumProtocolDecodeError')<{
  readonly message: string
  readonly cause: Schema.SchemaError
}> {}

const decode = Schema.decodeUnknownResult(IntradayMomentumProtocolSchema, strictParseOptions)

export const decodeIntradayMomentumProtocol = (
  input: unknown,
): Result.Result<IntradayMomentumProtocol, IntradayMomentumProtocolDecodeError> =>
  Result.mapError(
    decode(input),
    (cause) => new IntradayMomentumProtocolDecodeError({ message: 'invalid intraday-momentum parameters', cause }),
  )

export const decodeDefaultIntradayMomentumProtocol = (): Result.Result<
  IntradayMomentumProtocol,
  IntradayMomentumProtocolDecodeError
> => decodeIntradayMomentumProtocol(defaultIntradayMomentumProtocolDocument)

export const hashIntradayMomentumProtocol = (
  protocol: IntradayMomentumProtocol,
): Result.Result<string, CanonicalHashFailure> => canonicalHashV1Result(protocol)
