import { Data, Result, Schema } from 'effect'

import { ExecutionControllerTickSchema } from '../execution/controller'
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

export enum CaptureInvalidation {
  Overflow = 'BUFFER_OVERFLOW',
  Persistence = 'PERSISTENCE_FAILED_OR_UNKNOWN',
  Interrupted = 'INTERRUPTED',
  MissingRawIdentity = 'MISSING_RAW_IDENTITY',
  AssignmentChanged = 'ASSIGNMENT_CHANGED',
  InvalidEvent = 'INVALID_EVENT',
  ClockReversed = 'CLOCK_REVERSED',
  ControllerReplay = 'CONTROLLER_REPLAY_AMBIGUITY',
}

const PositionSchema = Schema.Struct({
  topic: StrictNonEmptyStringSchema,
  partition: NonNegativeIntegerSchema,
  offset: UnsignedMicrosSchema,
})

export const ResearchCaptureEventSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('market-record'),
    consumerEpoch: StrictNonEmptyStringSchema,
    consumerSequence: PositiveIntegerSchema,
    projectionSequence: NonNegativeIntegerSchema,
    topic: StrictNonEmptyStringSchema,
    partition: NonNegativeIntegerSchema,
    offset: UnsignedMicrosSchema,
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
  captureId: StrictNonEmptyStringSchema,
  sourceRevision: GitSourceRevisionSchema,
  chunkOrdinal: NonNegativeIntegerSchema,
  previousContentHash: Schema.NullOr(Sha256Schema),
  receipts: Schema.Array(ResearchCaptureReceiptSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
})
export type ResearchCaptureChunk = typeof ResearchCaptureChunkSchema.Type

export const ResearchCaptureSealSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-capture-seal.v1'),
  captureId: StrictNonEmptyStringSchema,
  sourceRevision: GitSourceRevisionSchema,
  closedAtMs: NonNegativeIntegerSchema,
  observedReceipts: NonNegativeIntegerSchema,
  persistedReceipts: NonNegativeIntegerSchema,
  persistedChunks: NonNegativeIntegerSchema,
  lastContentHash: Schema.NullOr(Sha256Schema),
  invalidations: Schema.Array(Schema.Enum(CaptureInvalidation)).check(Schema.isUnique()),
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
    if (sha256(input.payload) !== input.contentHash) return yield* Result.fail(fail('Capture chunk hash mismatch'))
    return yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(ResearchCaptureChunkSchema),
      strictParseOptions,
    )(input.payload)
  })

export const decodeResearchCaptureSeal = (input: ResearchCaptureBytes) =>
  Result.gen(function* () {
    if (sha256(input.payload) !== input.contentHash) return yield* Result.fail(fail('Capture seal hash mismatch'))
    return yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(ResearchCaptureSealSchema),
      strictParseOptions,
    )(input.payload)
  })

/** A seal describes one worker's capture. It is never evidence of an unobserved worker or epoch. */
export const verifyResearchCapture = (
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
        if (event.kind === 'consumer-boundary') {
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
    const complete =
      seal.invalidations.length === 0 &&
      completeSequence &&
      sequence === seal.observedReceipts &&
      activeEpoch === undefined
    if (seal.invalidations.length === 0 && !complete)
      return yield* Result.fail(fail('Capture seal cannot claim completeness with an omitted tail or open epoch'))
    return { seal, complete }
  })

export interface ResearchCaptureObserver {
  readonly record: (event: ResearchCaptureEvent, observedAtMs?: number) => void
  readonly invalidate: (reason: CaptureInvalidation) => void
}

/** Evidence failure must not escape into execution, including a faulty injected observer. */
export const recordResearchCapture = (
  observer: ResearchCaptureObserver | undefined,
  event: ResearchCaptureEvent,
  observedAtMs?: number,
): void => {
  if (observer === undefined) return
  const result = Result.try(() => observer.record(event, observedAtMs))
  if (Result.isFailure(result)) Result.try(() => observer.invalidate(CaptureInvalidation.InvalidEvent))
}

export const invalidateResearchCapture = (
  observer: ResearchCaptureObserver | undefined,
  reason: CaptureInvalidation,
): void => {
  if (observer !== undefined) Result.try(() => observer.invalidate(reason))
}
