import { Data, Effect, Result, Schema } from 'effect'

import { operationalError, type OperationalError } from '../../errors'
import { canonicalHashV1Result } from '../../hash'
import { Sha256Schema, UtcInstantSchema, UtcOrderTimestampSchema, strictParseOptions } from '../../schemas'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../../time'
import {
  IntradaySnapshotFailure,
  type ArchiveVerifiedIntradayMarketSnapshot,
  type IntradayBar,
  type IntradayCandidateExclusion,
  type IntradayMarketDataService,
  type IntradayMarketSnapshot,
  type IntradayQuote,
  type IntradayRecordIdentity,
  type IntradayTrade,
} from './model'
import { intradayInstantNanos } from './time'
import { reverifyIntradayMarketSnapshot } from './verification'

export enum ArchiveAvailabilityPolicy {
  RecordedReader = 'recorded-reader',
  SourceReceiptAssumption = 'source-receipt-assumption',
}

export enum ArchiveRecordKind {
  Bar = 'bar',
  Quote = 'quote',
  Trade = 'trade',
}

export const ArchiveReaderIdentitySchema = Schema.Struct({
  endpointHash: Sha256Schema,
  sourceRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  verification: Schema.Literals(['embedded', 'development-configured']),
})
export type ArchiveReaderIdentity = typeof ArchiveReaderIdentitySchema.Type

const ReceiptMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.archive-record-availability.v1'),
  reader: ArchiveReaderIdentitySchema,
  readStartedAt: UtcInstantSchema,
  availableAt: UtcInstantSchema,
  snapshotId: Sha256Schema,
  snapshotObservedAt: UtcInstantSchema,
  recordKind: Schema.Enum(ArchiveRecordKind),
  recordId: Sha256Schema,
  recordContentHash: Sha256Schema,
  record: Schema.Json,
})
export const ArchiveAvailabilityReceiptSchema = Schema.Struct({
  ...ReceiptMaterialSchema.fields,
  receiptHash: Sha256Schema,
})
export type ArchiveAvailabilityReceipt = typeof ArchiveAvailabilityReceiptSchema.Type

export interface ArchiveRecordReference {
  readonly recordId: string
  readonly recordContentHash: string
  readonly symbol: string
}

export interface ArchiveSnapshotAvailability {
  readonly snapshotId: string
  readonly observedAt: string
  readonly receipts: readonly ArchiveAvailabilityReceipt[]
  /** Reader-availability exclusions are separate from the immutable archive manifest. */
  readonly candidateExclusions?: readonly IntradayCandidateExclusion[]
}

export interface ReplayMarketDataService extends IntradayMarketDataService {
  readonly recordedAvailability?: (
    snapshot: ArchiveVerifiedIntradayMarketSnapshot,
  ) => Effect.Effect<ArchiveSnapshotAvailability, OperationalError>
}

export class ArchiveAvailabilityFailure extends Data.TaggedError('ArchiveAvailabilityFailure')<{
  readonly reason: 'clock' | 'hash' | 'identity' | 'missing' | 'rows'
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (reason: ArchiveAvailabilityFailure['reason'], message: string, cause?: unknown) =>
  new ArchiveAvailabilityFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })

const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(
    Result.mapError((cause) => failure('hash', 'archive availability evidence is not canonically hashable', cause)),
  )

type ArchiveRecord = IntradayBar | IntradayQuote | IntradayTrade
const records = (snapshot: IntradayMarketSnapshot): readonly [ArchiveRecordKind, ArchiveRecord][] => [
  ...snapshot.bars.map((record): [ArchiveRecordKind, ArchiveRecord] => [ArchiveRecordKind.Bar, record]),
  ...snapshot.quotes.map((record): [ArchiveRecordKind, ArchiveRecord] => [ArchiveRecordKind.Quote, record]),
  ...snapshot.trades.map((record): [ArchiveRecordKind, ArchiveRecord] => [ArchiveRecordKind.Trade, record]),
]

const recordReference = (kind: ArchiveRecordKind, record: ArchiveRecord) =>
  Result.all({
    recordId: recordIdentity(kind, record),
    recordContentHash: hash(record),
  }).pipe(Result.map((reference) => ({ ...reference, symbol: record.symbol })))

const ReceiptRecordIdentitySchema = Schema.Struct({
  provider: Schema.Literal('alpaca'),
  universeId: Schema.String,
  universeSymbolHash: Sha256Schema,
  feed: Schema.Literals(['iex', 'sip', 'delayed_sip']),
  sourceTopic: Schema.String,
  sourcePartition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sourceOffset: Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/)),
  ingestedAt: Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema]),
})

const recordIdentity = (
  kind: ArchiveRecordKind,
  record: Pick<
    IntradayRecordIdentity,
    'provider' | 'universeId' | 'universeSymbolHash' | 'feed' | 'sourceTopic' | 'sourcePartition' | 'sourceOffset'
  >,
) =>
  hash({
    kind,
    provider: record.provider,
    universeId: record.universeId,
    universeSymbolHash: record.universeSymbolHash,
    feed: record.feed,
    sourceTopic: record.sourceTopic,
    sourcePartition: record.sourcePartition,
    sourceOffset: record.sourceOffset,
  })

export const archiveRecordReferences = (snapshot: IntradayMarketSnapshot) =>
  Result.all(records(snapshot).map(([kind, record]) => recordReference(kind, record)))

/** The upper bound is the completion of an actual reader call, never the source receipt or insert-start time. */
export const makeArchiveAvailabilityReceipts = (
  snapshot: ArchiveVerifiedIntradayMarketSnapshot,
  reader: ArchiveReaderIdentity,
  readStartedAt: string,
  availableAt: string,
): Result.Result<readonly ArchiveAvailabilityReceipt[], ArchiveAvailabilityFailure> =>
  Result.gen(function* () {
    yield* reverifyIntradayMarketSnapshot(snapshot).pipe(
      Result.mapError((cause) => failure('rows', 'cannot record an invalid archive snapshot', cause)),
    )
    yield* Schema.decodeUnknownResult(
      Schema.Tuple([UtcInstantSchema, UtcInstantSchema]),
      strictParseOptions,
    )([readStartedAt, availableAt]).pipe(
      Result.mapError((cause) => failure('clock', 'archive read clocks must be canonical UTC instants', cause)),
    )
    if (readStartedAt < snapshot.manifest.observedAt || availableAt < readStartedAt) {
      return yield* Result.fail(failure('clock', 'archive visibility cannot predate the read or its source cutoff'))
    }
    return yield* Result.all(
      records(snapshot).map(([recordKind, record]) =>
        Result.gen(function* () {
          if (intradayInstantNanos(record.ingestedAt) > intradayInstantNanos(availableAt)) {
            return yield* Result.fail(failure('clock', 'archive visibility cannot predate source receipt'))
          }
          const { recordId, recordContentHash } = yield* recordReference(recordKind, record)
          const material = yield* Schema.decodeUnknownResult(
            ReceiptMaterialSchema,
            strictParseOptions,
          )({
            schemaVersion: 'bayn.archive-record-availability.v1',
            reader,
            readStartedAt,
            availableAt,
            snapshotId: snapshot.manifest.snapshotId,
            snapshotObservedAt: snapshot.manifest.observedAt,
            recordKind,
            recordId,
            recordContentHash,
            record,
          }).pipe(Result.mapError((cause) => failure('identity', 'archive reader receipt is invalid', cause)))
          return Object.freeze({ ...material, receiptHash: yield* hash(material) })
        }),
      ),
    )
  })

export const verifyArchiveAvailabilityReceipt = (
  input: unknown,
): Result.Result<ArchiveAvailabilityReceipt, ArchiveAvailabilityFailure> =>
  Result.gen(function* () {
    const receipt = yield* Schema.decodeUnknownResult(
      ArchiveAvailabilityReceiptSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => failure('identity', 'stored archive availability receipt is invalid', cause)),
    )
    const { receiptHash, ...material } = receipt
    if ((yield* hash(material)) !== receiptHash || (yield* hash(receipt.record)) !== receipt.recordContentHash) {
      return yield* Result.fail(failure('hash', 'stored archive availability receipt content was changed'))
    }
    if (receipt.readStartedAt < receipt.snapshotObservedAt || receipt.availableAt < receipt.readStartedAt) {
      return yield* Result.fail(failure('clock', 'stored archive receipt contains a regressed read clock'))
    }
    const identity = yield* Schema.decodeUnknownResult(ReceiptRecordIdentitySchema)(receipt.record).pipe(
      Result.mapError((cause) => failure('identity', 'stored archive receipt has invalid source identity', cause)),
    )
    if ((yield* recordIdentity(receipt.recordKind, identity)) !== receipt.recordId) {
      return yield* Result.fail(failure('identity', 'stored archive receipt does not bind its raw Kafka identity'))
    }
    if (intradayInstantNanos(identity.ingestedAt) > intradayInstantNanos(receipt.availableAt)) {
      return yield* Result.fail(failure('clock', 'stored archive visibility predates source receipt'))
    }
    return receipt
  })

export const verifyRecordedArchiveAvailability = (
  snapshot: ArchiveVerifiedIntradayMarketSnapshot,
  endpointHash: string,
  candidates: readonly unknown[],
): Result.Result<ArchiveSnapshotAvailability, ArchiveAvailabilityFailure> =>
  Result.gen(function* () {
    const references = yield* archiveRecordReferences(snapshot)
    const receipts = yield* Result.all(candidates.map(verifyArchiveAvailabilityReceipt))
    const byId = new Map(receipts.map((receipt) => [receipt.recordId, receipt]))
    const expectedIds = new Set(references.map((reference) => reference.recordId))
    if (byId.size !== receipts.length || receipts.some((receipt) => !expectedIds.has(receipt.recordId))) {
      return yield* Result.fail(
        failure('identity', 'archive availability contains duplicate or unrelated record receipts'),
      )
    }
    const independentCandidates = new Set(
      snapshot.manifest.purpose === undefined ? snapshot.manifest.candidateSymbols : [],
    )
    const candidateExclusions = new Map<string, IntradayCandidateExclusion>()
    for (const reference of references) {
      const receipt = byId.get(reference.recordId)
      if (
        receipt !== undefined &&
        (receipt.reader.endpointHash !== endpointHash ||
          receipt.reader.verification !== 'embedded' ||
          receipt.recordContentHash !== reference.recordContentHash)
      ) {
        return yield* Result.fail(failure('identity', 'archive availability does not bind the exact production record'))
      }
      if (receipt === undefined || receipt.availableAt > snapshot.manifest.observedAt) {
        if (!independentCandidates.has(reference.symbol)) {
          return yield* Result.fail(failure('missing', 'archive reader visibility is unproven for a required record'))
        }
        candidateExclusions.set(reference.symbol, {
          symbol: reference.symbol,
          reason: 'not-ready',
          message: 'intraday candidate archive reader visibility is unproven at replay time',
        })
      }
    }
    return Object.freeze({
      snapshotId: snapshot.manifest.snapshotId,
      observedAt: snapshot.manifest.observedAt,
      ...(candidateExclusions.size === 0
        ? {}
        : {
            candidateExclusions: Object.freeze(
              [...candidateExclusions.values()].toSorted((left, right) =>
                left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0,
              ),
            ),
          }),
      receipts: Object.freeze(
        receipts.toSorted((left, right) =>
          left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0,
        ),
      ),
    })
  })

export const archiveAvailabilityOperationalError = (cause: unknown): OperationalError =>
  operationalError({
    component: 'market-data',
    operation: 'archive-availability',
    message: 'archive reader availability evidence is unavailable or invalid',
    cause:
      cause instanceof ArchiveAvailabilityFailure && cause.reason === 'missing'
        ? new IntradaySnapshotFailure({ reason: 'not-ready', message: cause.message, cause })
        : cause,
  })

/** Only execution composition supplies this recorder. Status and historical-replay clients never write receipts. */
export const withRecordedArchiveReads = (
  market: IntradayMarketDataService,
  reader: ArchiveReaderIdentity,
  record: (receipts: readonly ArchiveAvailabilityReceipt[]) => Effect.Effect<void, OperationalError>,
  now: Effect.Effect<string> = currentUtcInstant,
): IntradayMarketDataService => {
  const observed = (read: Effect.Effect<ArchiveVerifiedIntradayMarketSnapshot, OperationalError>) =>
    Effect.gen(function* () {
      const startedAt = yield* now
      const snapshot = yield* read
      const completedAt = yield* now
      if (completedAt < startedAt) {
        return yield* archiveAvailabilityOperationalError(
          failure('clock', 'archive reader clock regressed during the read'),
        )
      }
      const receipts = yield* Effect.fromResult(
        // The clock is millisecond-resolution. Round its completion upper bound up, never down into the read.
        makeArchiveAvailabilityReceipts(
          snapshot,
          reader,
          startedAt,
          utcInstantFromEpochMillis(Date.parse(completedAt) + 1),
        ),
      ).pipe(Effect.mapError(archiveAvailabilityOperationalError))
      yield* record(receipts)
      return snapshot
    })
  return {
    check: market.check,
    captureVersion: market.captureVersion,
    loadSnapshot: (request) => observed(market.loadSnapshot(request)),
    verifyArchiveSnapshot: (snapshot) => observed(market.verifyArchiveSnapshot(snapshot)),
  }
}
