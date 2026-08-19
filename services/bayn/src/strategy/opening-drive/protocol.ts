import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256, type CanonicalHashFailure } from '../../hash'
import {
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  strictParseOptions,
} from '../../schemas'

const PositiveUnitIntervalSchema = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const BasisPointsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000))
const PartsPerMillionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000))

const coreUniverse = {
  id: 'torghut-core-equity-v1',
  symbols: ['AMD', 'AVGO', 'COHR', 'CRDO', 'LITE', 'MRVL', 'MU', 'NVDA', 'SNDK', 'WDC'],
  symbolHash: '8c6b71d066bce38f6f61d5264bb7ebdd45f44ee0c606b92ecf6bc68b81e1d49d',
} as const

const OpeningDriveProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.protocol.v1'),
  universeId: Schema.Literal('torghut-core-equity-v1'),
  universeSymbolHash: Sha256Schema,
  universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  feed: Schema.Literal('sip'),
  delayClass: Schema.Literal('real_time_consolidated'),
  positionPolicy: Schema.Literal('long-only'),
  openingRangeMinutes: PositiveIntegerSchema,
  decisionDelaySeconds: PositiveIntegerSchema,
  maximumQuoteAgeMs: PositiveIntegerSchema,
  entryCutoffMinutesAfterOpen: PositiveIntegerSchema,
  flattenBeforeCloseMinutes: PositiveIntegerSchema,
  hardFlatBeforeCloseMinutes: PositiveIntegerSchema,
  maximumPositions: PositiveIntegerSchema,
  maximumGrossWeight: PositiveUnitIntervalSchema,
  maximumSymbolWeight: PositiveUnitIntervalSchema,
  minimumOpeningReturnBps: BasisPointsSchema,
  minimumBreakoutBps: BasisPointsSchema,
  minimumRangeLocationPpm: PartsPerMillionSchema,
  maximumSpreadBps: BasisPointsSchema,
  minimumOpeningDollarVolumeMicros: PositiveMicrosSchema,
  allocation: Schema.Literal('equal-weight'),
})

const protocolIssues = (protocol: typeof OpeningDriveProtocolBase.Type): readonly Schema.FilterIssue[] => {
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
  return issues
}

export const OpeningDriveProtocolSchema = OpeningDriveProtocolBase.check(Schema.makeFilter(protocolIssues))
export type OpeningDriveProtocol = typeof OpeningDriveProtocolSchema.Type

export const defaultOpeningDriveProtocolDocument = {
  schemaVersion: 'bayn.opening-drive.protocol.v1',
  universeId: coreUniverse.id,
  universeSymbolHash: coreUniverse.symbolHash,
  universe: coreUniverse.symbols,
  feed: 'sip',
  delayClass: 'real_time_consolidated',
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
} as const

export const defaultOpeningDriveProtocolHash = '5e21b5eeea54756bad8c5861ce883da575654685b6629588fd086a2511d0165e'

export class OpeningDriveProtocolDecodeError extends Data.TaggedError('OpeningDriveProtocolDecodeError')<{
  readonly message: string
  readonly cause: Schema.SchemaError
}> {}

const decode = Schema.decodeUnknownResult(OpeningDriveProtocolSchema, strictParseOptions)

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

export const hashOpeningDriveProtocol = (protocol: OpeningDriveProtocol): Result.Result<string, CanonicalHashFailure> =>
  canonicalHashV1Result(protocol)
