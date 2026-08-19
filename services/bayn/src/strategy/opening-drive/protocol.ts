import { Data, Result, Schema } from 'effect'

import { ExecutionModelV4Schema, type ExecutionModel } from '../../execution-model-contract'
import { canonicalHashV1Result, sha256, type CanonicalHashFailure } from '../../hash'
import { maximumIntradayObservationLagMs, maximumIntradayQuoteAgeMs } from '../../market-data/intraday/verification'
import {
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  strictParseOptions,
} from '../../schemas'
import { defaultExecutionModel } from '../execution-model/model'

const PositiveUnitIntervalSchema = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const BasisPointsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000))
const PartsPerMillionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000))
const maximumIntradayMinuteOffset = 24 * 60
const IntradayMinuteOffsetSchema = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(maximumIntradayMinuteOffset))

const coreUniverse = {
  id: 'torghut-core-equity-v1',
  symbols: ['AMD', 'AVGO', 'COHR', 'CRDO', 'LITE', 'MRVL', 'MU', 'NVDA', 'SNDK', 'WDC'],
  symbolHash: '8c6b71d066bce38f6f61d5264bb7ebdd45f44ee0c606b92ecf6bc68b81e1d49d',
} as const

export const openingDriveExecutionModel: Extract<
  ExecutionModel,
  { readonly schemaVersion: 'bayn.execution-model.v4' }
> = Object.freeze({
  ...defaultExecutionModel,
  schemaVersion: 'bayn.execution-model.v4',
  order: Object.freeze({
    type: 'limit',
    timeInForce: 'ioc',
    extendedHours: false,
    planAfter: 'verified-opening-range',
    submitAfter: 'plan-committed',
    submitBefore: 'intraday-entry-cutoff',
    planningPriceReference: 'verified-adverse-top-of-book',
    planningBrokerStateReference: 'reconciled-pre-plan-broker-state',
    fillPriceReference: 'limit-or-better',
    buyingPowerPolicy: 'pre-submit-cash-without-sell-proceeds',
    decisionAfterOpenMs: 5 * 60_000 + 1_000,
    submissionCutoffAfterOpenMs: 30 * 60_000,
  }),
  precision: Object.freeze({
    ...defaultExecutionModel.precision,
    quantityIncrementMicros: '1000000',
  }),
})

const OpeningDriveProtocolCommon = {
  universeId: Schema.Literal('torghut-core-equity-v1'),
  universeSymbolHash: Sha256Schema,
  universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  positionPolicy: Schema.Literal('long-only'),
  openingRangeMinutes: PositiveIntegerSchema,
  decisionDelaySeconds: PositiveIntegerSchema,
  maximumQuoteAgeMs: PositiveIntegerSchema,
  entryCutoffMinutesAfterOpen: IntradayMinuteOffsetSchema,
  flattenBeforeCloseMinutes: IntradayMinuteOffsetSchema,
  hardFlatBeforeCloseMinutes: IntradayMinuteOffsetSchema,
  maximumPositions: PositiveIntegerSchema,
  maximumGrossWeight: PositiveUnitIntervalSchema,
  maximumSymbolWeight: PositiveUnitIntervalSchema,
  minimumOpeningReturnBps: BasisPointsSchema,
  minimumBreakoutBps: BasisPointsSchema,
  minimumRangeLocationPpm: PartsPerMillionSchema,
  maximumSpreadBps: BasisPointsSchema,
  minimumOpeningDollarVolumeMicros: PositiveMicrosSchema,
  allocation: Schema.Literal('equal-weight'),
} as const

const OpeningDriveProtocolV1Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.protocol.v1'),
  ...OpeningDriveProtocolCommon,
})

const OpeningDriveProtocolV2Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.protocol.v2'),
  ...OpeningDriveProtocolCommon,
  executionModel: ExecutionModelV4Schema,
})

type OpeningDriveProtocolEvidence = typeof OpeningDriveProtocolV1Base.Type | typeof OpeningDriveProtocolV2Base.Type

const protocolIssues = (protocol: OpeningDriveProtocolEvidence): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const canonicalUniverse = [...new Set(protocol.universe)].sort()
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
    issues.push({ path: ['universeId'], issue: 'must bind the exact source-controlled consolidated universe' })
  }
  if (protocol.openingRangeMinutes > 30) {
    issues.push({ path: ['openingRangeMinutes'], issue: 'must not exceed the bounded archive window' })
  }
  if (protocol.decisionDelaySeconds * 1_000 > maximumIntradayObservationLagMs) {
    issues.push({ path: ['decisionDelaySeconds'], issue: 'must fit the verified post-range observation window' })
  }
  if (protocol.maximumQuoteAgeMs > maximumIntradayQuoteAgeMs) {
    issues.push({ path: ['maximumQuoteAgeMs'], issue: 'must fit the verified quote and trade freshness window' })
  }
  if (protocol.entryCutoffMinutesAfterOpen * 60 <= protocol.openingRangeMinutes * 60 + protocol.decisionDelaySeconds) {
    issues.push({
      path: ['entryCutoffMinutesAfterOpen'],
      issue: 'must be strictly after the opening range and post-range decision delay',
    })
  }
  if (protocol.maximumPositions > protocol.universe.length) {
    issues.push({ path: ['maximumPositions'], issue: 'must not exceed the universe size' })
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
      issue: 'must preserve at least one part-per-million of executable target weight after portfolio rounding',
    })
  }
  if (protocol.hardFlatBeforeCloseMinutes >= protocol.flattenBeforeCloseMinutes) {
    issues.push({ path: ['hardFlatBeforeCloseMinutes'], issue: 'must follow the initial flatten boundary' })
  }
  if (protocol.schemaVersion === 'bayn.opening-drive.protocol.v2') {
    const expectedDecisionAfterOpenMs = protocol.openingRangeMinutes * 60_000 + protocol.decisionDelaySeconds * 1_000
    const expectedSubmissionCutoffAfterOpenMs = protocol.entryCutoffMinutesAfterOpen * 60_000
    if (
      protocol.executionModel.order.decisionAfterOpenMs !== expectedDecisionAfterOpenMs ||
      protocol.executionModel.order.submissionCutoffAfterOpenMs !== expectedSubmissionCutoffAfterOpenMs
    ) {
      issues.push({ path: ['executionModel', 'order'], issue: 'must bind the exact opening-drive decision window' })
    }
    if (protocol.executionModel.precision.quantityIncrementMicros !== '1000000') {
      issues.push({ path: ['executionModel', 'precision'], issue: 'IOC equity execution requires whole-share sizing' })
    }
  }
  return issues
}

export const OpeningDriveProtocolV1Schema = OpeningDriveProtocolV1Base.check(Schema.makeFilter(protocolIssues))
export const OpeningDriveProtocolSchema = OpeningDriveProtocolV2Base.check(Schema.makeFilter(protocolIssues))
export type OpeningDriveProtocolV1 = typeof OpeningDriveProtocolV1Schema.Type
export type OpeningDriveProtocol = typeof OpeningDriveProtocolSchema.Type

export const openingDriveProtocolV1Document = Object.freeze({
  schemaVersion: 'bayn.opening-drive.protocol.v1',
  universeId: coreUniverse.id,
  universeSymbolHash: coreUniverse.symbolHash,
  universe: coreUniverse.symbols,
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  positionPolicy: 'long-only',
  openingRangeMinutes: 5,
  decisionDelaySeconds: 1,
  maximumQuoteAgeMs: 1_000,
  entryCutoffMinutesAfterOpen: 30,
  flattenBeforeCloseMinutes: 30,
  hardFlatBeforeCloseMinutes: 15,
  maximumPositions: 3,
  maximumGrossWeight: 0.3,
  maximumSymbolWeight: 0.1,
  minimumOpeningReturnBps: 30,
  minimumBreakoutBps: 5,
  minimumRangeLocationPpm: 800_000,
  maximumSpreadBps: 15,
  minimumOpeningDollarVolumeMicros: '250000000000',
  allocation: 'equal-weight',
} as const)

export const openingDriveProtocolV1Hash = '5e21b5eeea54756bad8c5861ce883da575654685b6629588fd086a2511d0165e'

export const defaultOpeningDriveProtocolDocument = Object.freeze({
  ...openingDriveProtocolV1Document,
  schemaVersion: 'bayn.opening-drive.protocol.v2',
  executionModel: openingDriveExecutionModel,
} as const)

export const defaultOpeningDriveProtocolHash = '4f2d4ba6c9ef6e997660f190db2ad23ee03e7c89b45021882efceff1c715269a'

export class OpeningDriveProtocolDecodeError extends Data.TaggedError('OpeningDriveProtocolDecodeError')<{
  readonly message: string
  readonly cause: Schema.SchemaError
}> {}

const decode = Schema.decodeUnknownResult(OpeningDriveProtocolSchema, strictParseOptions)
const decodeV1 = Schema.decodeUnknownResult(OpeningDriveProtocolV1Schema, strictParseOptions)

export const decodeOpeningDriveProtocolV1 = (
  input: unknown,
): Result.Result<OpeningDriveProtocolV1, OpeningDriveProtocolDecodeError> =>
  Result.mapError(
    decodeV1(input),
    (cause) => new OpeningDriveProtocolDecodeError({ message: 'invalid opening-drive v1 parameters', cause }),
  )

export const decodeOpeningDriveProtocol = (
  input: unknown,
): Result.Result<OpeningDriveProtocol, OpeningDriveProtocolDecodeError> =>
  Result.mapError(
    decode(input),
    (cause) => new OpeningDriveProtocolDecodeError({ message: 'invalid opening-drive parameters', cause }),
  )

export const decodeDefaultOpeningDriveProtocol = (): Result.Result<
  OpeningDriveProtocol,
  OpeningDriveProtocolDecodeError
> => decodeOpeningDriveProtocol(defaultOpeningDriveProtocolDocument)

export const hashOpeningDriveProtocol = (
  protocol: OpeningDriveProtocol | OpeningDriveProtocolV1,
): Result.Result<string, CanonicalHashFailure> => canonicalHashV1Result(protocol)
