import { Data, Result, Schema } from 'effect'

import { ExecutionControllerTickSchema } from '../execution/controller'
import { JevObservationReferencesSchema } from '../cycle/runner/pass-observation'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap'
import { sha256 } from '../hash'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

export enum CaptureDisposition {
  Accepted = 'ACCEPTED',
  Rejected = 'REJECTED',
  Ignored = 'IGNORED',
}

export enum CaptureQualification {
  Unqualified = 'UNQUALIFIED',
}

export const maximumResearchCaptureChunkBytes = 4 * 1024 * 1024
export const maximumResearchCaptureSealBytes = 64 * 1024
export const ResearchCaptureIdSchema = StrictNonEmptyStringSchema.check(Schema.isMaxLength(512))

export enum CaptureInvalidation {
  Overflow = 'BUFFER_OVERFLOW',
  Persistence = 'PERSISTENCE_FAILED_OR_UNKNOWN',
  Interrupted = 'INTERRUPTED',
  MissingRawIdentity = 'MISSING_RAW_IDENTITY',
  AssignmentChanged = 'ASSIGNMENT_CHANGED',
  InvalidEvent = 'INVALID_EVENT',
  ClockReversed = 'CLOCK_REVERSED',
  ControllerReplay = 'CONTROLLER_REPLAY_AMBIGUITY',
  Finalization = 'FINALIZATION_FAILED_OR_UNKNOWN',
  ByteLimit = 'SESSION_BYTE_LIMIT',
  MissedBootstrap = 'SESSION_BOOTSTRAP_MISSED',
  Deadline = 'SESSION_DEADLINE_WITHOUT_CUT',
  WorkerReplaced = 'SESSION_WORKER_REPLACED',
  OutsideWindow = 'SESSION_START_OUTSIDE_WINDOW',
}

const PositionSchema = Schema.Struct({
  topic: StrictNonEmptyStringSchema,
  partition: NonNegativeIntegerSchema,
  offset: UnsignedMicrosSchema,
})

export const CaptureIntervalRequestSchema = Schema.Struct({
  intervalId: ResearchCaptureIdSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  universeHash: Sha256Schema,
  expectedPartitions: Schema.Array(
    Schema.Struct({
      topic: StrictNonEmptyStringSchema,
      partition: NonNegativeIntegerSchema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type CaptureIntervalRequest = typeof CaptureIntervalRequestSchema.Type

export const CaptureSessionDeclarationSchema = Schema.Struct({
  ...CaptureIntervalRequestSchema.fields,
  startAtMs: NonNegativeIntegerSchema,
  bootstrapDeadlineMs: NonNegativeIntegerSchema,
  stopAtMs: NonNegativeIntegerSchema,
  calendarSnapshotId: Sha256Schema,
  calendarObservedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  maximumObjectBytes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(24 * 1024 ** 3)),
  maximumSqlBytes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(10 * 1024 ** 3)),
})

export const CaptureIntervalCutSchema = Schema.Struct({
  kind: Schema.Literal('consumer-interval-cut'),
  schemaVersion: Schema.Literal('bayn.native-visible-input-cut.v1'),
  ...CaptureIntervalRequestSchema.fields,
  consumerEpoch: StrictNonEmptyStringSchema,
  transport: Schema.Struct({
    sdk: Schema.Literal('@platformatic/kafka'),
    version: Schema.Literal('2.12.1'),
    isolation: Schema.Literal('READ_COMMITTED'),
    mode: Schema.Literal('MANUAL'),
    fallback: Schema.Literal('FAIL'),
    deserializationFailure: Schema.Literal('FAIL'),
  }),
  committedFence: Schema.Struct({
    lookupStartedAtMs: NonNegativeIntegerSchema,
    lookupCompletedAtMs: NonNegativeIntegerSchema,
    positions: Schema.Array(PositionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  drainedPositions: Schema.Array(PositionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  finalConsumerSequence: NonNegativeIntegerSchema,
})
export type CaptureIntervalCut = typeof CaptureIntervalCutSchema.Type

export enum CaptureTimestampKind {
  Value = 'VALUE',
  Missing = 'MISSING',
  NotANumber = 'NAN',
  PositiveInfinity = 'POSITIVE_INFINITY',
  NegativeInfinity = 'NEGATIVE_INFINITY',
  NegativeZero = 'NEGATIVE_ZERO',
}
const CaptureTimestampSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(CaptureTimestampKind.Value),
    value: Schema.Finite.check(
      Schema.makeFilter((value: number) => !Object.is(value, -0), {
        expected: 'a finite timestamp with negative zero separately tagged',
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literals([
      CaptureTimestampKind.Missing,
      CaptureTimestampKind.NotANumber,
      CaptureTimestampKind.PositiveInfinity,
      CaptureTimestampKind.NegativeInfinity,
      CaptureTimestampKind.NegativeZero,
    ]),
  }),
])
export const OriginalKafkaTransportSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.kafka-original-transport.v1'),
  timestampMs: CaptureTimestampSchema,
})
type CapturedTimestamp = typeof CaptureTimestampSchema.Type
const captureTimestamp = (value: number | undefined): CapturedTimestamp => {
  if (value === undefined) return { kind: CaptureTimestampKind.Missing }
  if (Number.isNaN(value)) return { kind: CaptureTimestampKind.NotANumber }
  if (value === Infinity) return { kind: CaptureTimestampKind.PositiveInfinity }
  if (value === -Infinity) return { kind: CaptureTimestampKind.NegativeInfinity }
  if (Object.is(value, -0)) return { kind: CaptureTimestampKind.NegativeZero }
  return { kind: CaptureTimestampKind.Value, value }
}
export const captureKafkaTransport = (timestampMs: number | undefined): typeof OriginalKafkaTransportSchema.Type => ({
  schemaVersion: 'bayn.kafka-original-transport.v1',
  timestampMs: captureTimestamp(timestampMs),
})
export const restoreKafkaTransportTimestamp = (
  transport: typeof OriginalKafkaTransportSchema.Type,
): number | undefined => {
  switch (transport.timestampMs.kind) {
    case CaptureTimestampKind.Value:
      return transport.timestampMs.value
    case CaptureTimestampKind.Missing:
      return undefined
    case CaptureTimestampKind.NotANumber:
      return NaN
    case CaptureTimestampKind.PositiveInfinity:
      return Infinity
    case CaptureTimestampKind.NegativeInfinity:
      return -Infinity
    case CaptureTimestampKind.NegativeZero:
      return -0
  }
}

export const ResearchCaptureEventSchema = Schema.Union([
  CaptureIntervalCutSchema,
  Schema.Struct({
    kind: Schema.Literal('session-attempt'),
    attemptId: StrictNonEmptyStringSchema,
    session: CaptureSessionDeclarationSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('market-record'),
    consumerEpoch: StrictNonEmptyStringSchema,
    consumerSequence: PositiveIntegerSchema,
    projectionSequence: NonNegativeIntegerSchema,
    topic: StrictNonEmptyStringSchema,
    partition: NonNegativeIntegerSchema,
    offset: UnsignedMicrosSchema,
    originalTransport: Schema.optionalKey(OriginalKafkaTransportSchema),
    rawValueSha256: Schema.NullOr(Sha256Schema),
    rawByteLength: Schema.NullOr(NonNegativeIntegerSchema),
    tombstone: Schema.Boolean,
    bootstrap: Schema.Boolean,
    disposition: Schema.Enum(CaptureDisposition),
    reason: Schema.optionalKey(StrictNonEmptyStringSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('consumer-boundary'),
    consumerEpoch: StrictNonEmptyStringSchema,
    phase: Schema.Literals(['STARTED', 'ASSIGNED', 'BOOTSTRAPPED', 'INVALIDATED', 'STOPPED']),
    positions: Schema.Array(PositionSchema),
    bootstrap: Schema.optionalKey(
      Schema.Struct({
        schemaVersion: Schema.Literal('bayn.kafka-bootstrap.v1'),
        epoch: StrictNonEmptyStringSchema,
        observedAtMs: NonNegativeIntegerSchema,
        lowerTimestampMs: NonNegativeIntegerSchema,
        timestampPolicy: Schema.Enum(KafkaBootstrapTimestampPolicy),
        partitions: Schema.Array(
          Schema.Struct({
            topic: StrictNonEmptyStringSchema,
            partition: NonNegativeIntegerSchema,
            logStartOffset: UnsignedMicrosSchema,
            startOffset: UnsignedMicrosSchema,
            endOffset: UnsignedMicrosSchema,
          }),
        ),
      }),
    ),
    reason: Schema.optionalKey(StrictNonEmptyStringSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('controller-pass'),
    phase: Schema.Literals(['SCHEDULED', 'STARTED', 'COMPLETED', 'FAILED', 'IGNORED']),
    controllerKey: Sha256Schema,
    invocationId: StrictNonEmptyStringSchema,
    sourceRevision: GitSourceRevisionSchema,
    tick: ExecutionControllerTickSchema,
    commandIssuedAt: Schema.optionalKey(UtcInstantSchema),
    idempotencyKey: Schema.optionalKey(StrictNonEmptyStringSchema),
    delayMs: Schema.optionalKey(NonNegativeIntegerSchema),
    completedAt: Schema.optionalKey(UtcInstantSchema),
    receiptHash: Schema.optionalKey(Sha256Schema),
    jevObservationReferences: Schema.optionalKey(JevObservationReferencesSchema),
    runtimeAttempted: Schema.optionalKey(Schema.Boolean),
    reason: Schema.optionalKey(StrictNonEmptyStringSchema),
  }),
])
export type ResearchCaptureEvent = typeof ResearchCaptureEventSchema.Type

export const ResearchCaptureReceiptSchema = Schema.Struct({
  sequence: PositiveIntegerSchema,
  observedAtMs: NonNegativeIntegerSchema,
  event: ResearchCaptureEventSchema,
})
export type ResearchCaptureReceipt = typeof ResearchCaptureReceiptSchema.Type

export const ResearchCaptureChunkSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-capture-chunk.v1'),
  captureId: ResearchCaptureIdSchema,
  sourceRevision: GitSourceRevisionSchema,
  chunkOrdinal: NonNegativeIntegerSchema,
  previousContentHash: Schema.NullOr(Sha256Schema),
  receipts: Schema.Array(ResearchCaptureReceiptSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
})
export type ResearchCaptureChunk = typeof ResearchCaptureChunkSchema.Type

const ResearchCaptureExportRootSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-capture-export-root.v1'),
  lastIndexHash: Schema.NullOr(Sha256Schema),
  exportedChunks: NonNegativeIntegerSchema,
})

export const ResearchCaptureSealSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-capture-seal.v1'),
  qualification: Schema.Enum(CaptureQualification),
  captureId: ResearchCaptureIdSchema,
  sourceRevision: GitSourceRevisionSchema,
  closedAtMs: NonNegativeIntegerSchema,
  observedReceipts: NonNegativeIntegerSchema,
  persistedReceipts: NonNegativeIntegerSchema,
  persistedChunks: NonNegativeIntegerSchema,
  lastContentHash: Schema.NullOr(Sha256Schema),
  invalidations: Schema.Array(Schema.Enum(CaptureInvalidation)).check(Schema.isUnique()),
  exportRoot: Schema.optionalKey(ResearchCaptureExportRootSchema),
})
export type ResearchCaptureSeal = typeof ResearchCaptureSealSchema.Type

export interface ResearchCaptureBytes {
  readonly contentHash: string
  readonly payload: string
}

export class ResearchCaptureFailure extends Data.TaggedError('ResearchCaptureFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const encodeResearchCapture = (value: ResearchCaptureChunk | ResearchCaptureSeal): ResearchCaptureBytes => {
  const payload = JSON.stringify(value)
  return { contentHash: sha256(payload), payload }
}

const fail = (message: string) => new ResearchCaptureFailure({ message })

export const decodeResearchCaptureChunk = (input: ResearchCaptureBytes) =>
  Result.gen(function* () {
    if (Buffer.byteLength(input.payload, 'utf8') > maximumResearchCaptureChunkBytes)
      return yield* Result.fail(fail('Capture chunk exceeds the exact UTF8 payload limit'))
    if (sha256(input.payload) !== input.contentHash) return yield* Result.fail(fail('Capture chunk hash mismatch'))
    return yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(ResearchCaptureChunkSchema),
      strictParseOptions,
    )(input.payload)
  })

export const decodeResearchCaptureSeal = (input: ResearchCaptureBytes) =>
  Result.gen(function* () {
    if (Buffer.byteLength(input.payload, 'utf8') > maximumResearchCaptureSealBytes)
      return yield* Result.fail(fail('Capture seal exceeds the exact UTF8 payload limit'))
    if (sha256(input.payload) !== input.contentHash) return yield* Result.fail(fail('Capture seal hash mismatch'))
    const seal = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(ResearchCaptureSealSchema),
      strictParseOptions,
    )(input.payload)
    if (
      seal.exportRoot !== undefined &&
      (seal.exportRoot.exportedChunks !== seal.persistedChunks ||
        (seal.persistedChunks === 0 ? seal.exportRoot.lastIndexHash !== null : seal.exportRoot.lastIndexHash === null))
    )
      return yield* Result.fail(fail('Export root differs from the exact persisted chunk frontier'))
    return seal
  })

/** A seal describes one worker's capture. It is never evidence of an unobserved worker or epoch. */
export const verifyResearchCapturePrefix = (
  chunks: readonly ResearchCaptureBytes[],
  sealBytes: ResearchCaptureBytes | undefined,
) =>
  Result.gen(function* () {
    if (sealBytes === undefined) return yield* Result.fail(fail('Unsealed capture has an unknown crash tail'))
    const seal = yield* decodeResearchCaptureSeal(sealBytes)
    let previousHash: string | null = null
    let sequence = 0
    let lastAtMs = 0
    let completeSequence = true
    const consumers = new Map<string, number>()
    let activeEpoch: string | undefined
    let declaredSession: typeof CaptureSessionDeclarationSchema.Type | undefined
    for (const [ordinal, bytes] of chunks.entries()) {
      const chunk = yield* decodeResearchCaptureChunk(bytes)
      if (
        chunk.captureId !== seal.captureId ||
        chunk.sourceRevision !== seal.sourceRevision ||
        chunk.chunkOrdinal !== ordinal ||
        chunk.previousContentHash !== previousHash
      )
        return yield* Result.fail(fail('Capture chunk identity, ordinal, or hash chain mismatch'))
      for (const receipt of chunk.receipts) {
        if (receipt.sequence <= sequence || receipt.observedAtMs < lastAtMs)
          return yield* Result.fail(fail('Capture receipts repeat or reverse their observed order'))
        completeSequence &&= receipt.sequence === sequence + 1
        sequence = receipt.sequence
        lastAtMs = receipt.observedAtMs
        const event = receipt.event
        if (event.kind === 'session-attempt') {
          if (
            ordinal !== 0 ||
            receipt.sequence !== 1 ||
            chunk.receipts.length !== 1 ||
            receipt.observedAtMs < event.session.startAtMs ||
            event.session.startAtMs >= event.session.bootstrapDeadlineMs ||
            receipt.observedAtMs >= event.session.bootstrapDeadlineMs ||
            event.session.bootstrapDeadlineMs >= event.session.coverageStartMs ||
            event.session.coverageStartMs >= event.session.coverageEndMs ||
            event.session.coverageEndMs >= event.session.stopAtMs
          )
            return yield* Result.fail(fail('A session attempt must be the sole first receipt in its claim chunk'))
          declaredSession = event.session
        } else if (event.kind === 'consumer-interval-cut' && declaredSession !== undefined) {
          if (
            event.intervalId !== declaredSession.intervalId ||
            event.coverageStartMs !== declaredSession.coverageStartMs ||
            event.coverageEndMs !== declaredSession.coverageEndMs ||
            event.universeHash !== declaredSession.universeHash ||
            JSON.stringify(event.expectedPartitions) !== JSON.stringify(declaredSession.expectedPartitions) ||
            receipt.observedAtMs >= declaredSession.stopAtMs
          )
            return yield* Result.fail(fail('Capture cut differs from its fixed session declaration or stop deadline'))
        } else if (event.kind === 'consumer-boundary') {
          if (event.phase === 'STARTED') {
            if (activeEpoch !== undefined || consumers.has(event.consumerEpoch))
              return yield* Result.fail(fail('Capture consumer epochs overlap or restart without a new identity'))
            consumers.set(event.consumerEpoch, 0)
            activeEpoch = event.consumerEpoch
          } else {
            if (activeEpoch !== event.consumerEpoch)
              return yield* Result.fail(fail('Capture boundary does not belong to the active consumer epoch'))
            if (event.phase === 'STOPPED') activeEpoch = undefined
          }
        } else if (event.kind === 'market-record') {
          const prior = consumers.get(event.consumerEpoch)
          if (activeEpoch !== event.consumerEpoch || prior === undefined || event.consumerSequence !== prior + 1)
            return yield* Result.fail(fail('Capture market receipts omit or mix consumer epoch ordering'))
          if (
            event.tombstone
              ? event.rawValueSha256 !== null || event.rawByteLength !== null
              : event.rawValueSha256 === null || event.rawByteLength === null
          )
            return yield* Result.fail(fail('Capture market receipt lacks its exact raw identity'))
          consumers.set(event.consumerEpoch, event.consumerSequence)
        }
      }
      previousHash = bytes.contentHash
    }
    if (
      chunks.length !== seal.persistedChunks ||
      previousHash !== seal.lastContentHash ||
      sequence !== seal.persistedReceipts ||
      seal.observedReceipts < sequence ||
      seal.closedAtMs < lastAtMs
    )
      return yield* Result.fail(fail('Capture seal omits or changes its retained tail'))
    const structurallyClosed =
      seal.invalidations.length === 0 &&
      completeSequence &&
      sequence === seal.observedReceipts &&
      activeEpoch === undefined
    return {
      seal,
      structurallyClosed,
      continuous: completeSequence && sequence === seal.observedReceipts,
      complete: false,
    }
  })

export const verifyResearchCapture = (
  chunks: readonly ResearchCaptureBytes[],
  sealBytes: ResearchCaptureBytes | undefined,
) =>
  Result.gen(function* () {
    const capture = yield* verifyResearchCapturePrefix(chunks, sealBytes)
    if (capture.seal.invalidations.length === 0 && !capture.structurallyClosed)
      return yield* Result.fail(
        fail('Capture seal omits an observed tail or leaves an open epoch without invalidation'),
      )
    return capture
  })

export interface ResearchCaptureObserver {
  readonly rawValues?: boolean
  readonly record: (event: ResearchCaptureEvent, observedAtMs?: number, rawValue?: Uint8Array | null) => void
  readonly invalidate: (reason: CaptureInvalidation) => void
}

export const capturesResearchRawValues = (observer: ResearchCaptureObserver | undefined): boolean => {
  if (observer === undefined) return false
  const result = Result.try(() => observer.rawValues === true)
  if (Result.isSuccess(result)) return result.success
  invalidateResearchCapture(observer, CaptureInvalidation.InvalidEvent)
  return false
}

const freezeCaptureMetadata = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const nested of Object.values(value)) freezeCaptureMetadata(nested)
}

/** Evidence failure must not escape into execution, including a faulty injected observer. */
export const recordResearchCapture = (
  observer: ResearchCaptureObserver | undefined,
  event: ResearchCaptureEvent,
  observedAtMs?: number,
  rawValue?: Uint8Array | null,
): void => {
  if (observer === undefined) return
  const result = Result.try(() => {
    const detached = structuredClone(event)
    freezeCaptureMetadata(detached)
    observer.record(detached, observedAtMs, rawValue)
  })
  if (Result.isFailure(result)) Result.try(() => observer.invalidate(CaptureInvalidation.InvalidEvent))
}

export const invalidateResearchCapture = (
  observer: ResearchCaptureObserver | undefined,
  reason: CaptureInvalidation,
): void => {
  if (observer !== undefined) Result.try(() => observer.invalidate(reason))
}
