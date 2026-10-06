import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import fc from 'fast-check'
import { sha256 } from '../hash'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap'
import { strictParseOptions } from '../schemas'

import { captureEvent, marketEvent } from './capture.test-support'
import {
  CaptureInvalidation,
  CaptureQualification,
  CaptureTimestampKind,
  OriginalKafkaTransportSchema,
  ResearchCaptureReceiptSchema,
  captureKafkaTransport,
  restoreKafkaTransportTimestamp,
  decodeResearchCaptureChunk,
  decodeResearchCaptureSeal,
  encodeResearchCapture,
  maximumResearchCaptureChunkBytes,
  recordResearchCapture,
  verifyResearchCapture,
  type ResearchCaptureChunk,
  type ResearchCaptureEvent,
  type ResearchCaptureSeal,
} from './capture'

test.each([undefined, NaN, Infinity, -Infinity, -0, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1789135202000])(
  'original adapter timestamp survives exact JSON round-trip (%s)',
  (timestampMs) => {
    const bytes = JSON.stringify(captureKafkaTransport(timestampMs))
    const decoded = Result.getOrThrow(
      Schema.decodeUnknownResult(Schema.fromJsonString(OriginalKafkaTransportSchema))(bytes),
    )
    expect(Object.is(restoreKafkaTransportTimestamp(decoded), timestampMs)).toBe(true)
    expect(bytes).not.toContain('null')
  },
)
test('negative zero cannot enter the finite timestamp variant and silently normalize', () => {
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(OriginalKafkaTransportSchema)({
        schemaVersion: 'bayn.kafka-original-transport.v1',
        timestampMs: { kind: CaptureTimestampKind.Value, value: -0 },
      }),
    ),
  ).toBe(true)
})

const captureFixture = () => {
  const chunk: ResearchCaptureChunk = {
    schemaVersion: 'bayn.research-capture-chunk.v1',
    captureId: 'capture-1',
    sourceRevision: 'a'.repeat(40),
    chunkOrdinal: 0,
    previousContentHash: null,
    receipts: [captureEvent('STARTED'), marketEvent, captureEvent('STOPPED')].map((event, index) => ({
      sequence: index + 1,
      observedAtMs: 100,
      event,
    })),
  }
  const bytes = encodeResearchCapture(chunk)
  const seal: ResearchCaptureSeal = {
    schemaVersion: 'bayn.research-capture-seal.v1',
    qualification: CaptureQualification.Unqualified,
    captureId: chunk.captureId,
    sourceRevision: chunk.sourceRevision,
    closedAtMs: 100,
    observedReceipts: 3,
    persistedReceipts: 3,
    persistedChunks: 1,
    lastContentHash: bytes.contentHash,
    invalidations: [],
  }
  return { chunk, bytes, seal }
}

test.each(['receipt', 'event', 'transport', 'prototype', 'symbol'] as const)(
  'compiled capture validation rejects excess %s properties before serialization',
  (location) => {
    const receipt = {
      sequence: 1,
      observedAtMs: 100,
      event: { ...marketEvent, originalTransport: captureKafkaTransport(100) },
    }
    const target =
      location === 'event' ? receipt.event : location === 'transport' ? receipt.event.originalTransport : receipt
    Object.defineProperty(
      target,
      location === 'prototype' ? '__proto__' : location === 'symbol' ? Symbol('extra') : 'extra',
      {
        value: true,
        enumerable: true,
      },
    )
    expect(
      Result.isFailure(Schema.decodeUnknownResult(ResearchCaptureReceiptSchema, strictParseOptions)(receipt)),
    ).toBe(true)
    if (location !== 'symbol') {
      const { chunk } = captureFixture()
      expect(
        Result.isFailure(decodeResearchCaptureChunk(encodeResearchCapture({ ...chunk, receipts: [receipt] }))),
      ).toBe(true)
    }
  },
)

test.each([undefined, null, -1, 0, 1.5, NaN, Infinity])(
  'compiled receipt and chunk validation reject malformed sequence %s',
  (sequence) => {
    const { chunk } = captureFixture()
    const receipt = { sequence, observedAtMs: 100, event: marketEvent }
    expect(
      Result.isFailure(Schema.decodeUnknownResult(ResearchCaptureReceiptSchema, strictParseOptions)(receipt)),
    ).toBe(true)
    const payload = JSON.stringify({ ...chunk, receipts: [receipt] })
    expect(Result.isFailure(decodeResearchCaptureChunk({ payload, contentHash: sha256(payload) }))).toBe(true)
  },
)

test('compiled receipt decoding retains prototype-independent values without sharing the input', () => {
  const event = Object.assign(Object.create(null), marketEvent)
  const receipt = Object.assign(Object.create(null), { sequence: 1, observedAtMs: 100, event })
  const decoded = Result.getOrThrow(
    Schema.decodeUnknownResult(ResearchCaptureReceiptSchema, strictParseOptions)(receipt),
  )
  expect(decoded).toEqual({ sequence: 1, observedAtMs: 100, event: marketEvent })
  expect(decoded).not.toBe(receipt)
  expect(decoded.event).not.toBe(event)
})

test('controller observation references survive retained capture encoding and decoding', () => {
  const { chunk } = captureFixture()
  const jevObservationReferences = { hashes: ['a'.repeat(64), 'b'.repeat(64)], complete: false }
  const receipt = {
    sequence: 1,
    observedAtMs: 100,
    event: {
      kind: 'controller-pass' as const,
      phase: 'COMPLETED' as const,
      controllerKey: 'c'.repeat(64),
      invocationId: 'original-controller-invocation',
      sourceRevision: chunk.sourceRevision,
      tick: { schemaVersion: 'bayn.execution-controller-tick.v1' as const, epoch: 1, sequence: 2 },
      receiptHash: 'd'.repeat(64),
      jevObservationReferences,
    },
  }
  const retained = Result.getOrThrow(
    decodeResearchCaptureChunk(encodeResearchCapture({ ...chunk, receipts: [receipt] })),
  )
  expect(retained.receipts).toEqual([receipt])
})

test('sealed receipts bind exact bytes, consumer order, and the complete observed tail', () => {
  const { chunk, bytes, seal } = captureFixture()
  const verified = Result.getOrThrow(verifyResearchCapture([bytes], encodeResearchCapture(seal)))
  expect(verified.structurallyClosed).toBe(true)
  expect(verified.complete).toBe(false)
  expect(Result.isFailure(verifyResearchCapture([bytes], undefined))).toBe(true)
  expect(
    Result.isFailure(verifyResearchCapture([{ ...bytes, payload: `${bytes.payload} ` }], encodeResearchCapture(seal))),
  ).toBe(true)
  expect(
    Result.isFailure(verifyResearchCapture([bytes], encodeResearchCapture({ ...seal, observedReceipts: 4 }))),
  ).toBe(true)
  expect(Result.isFailure(verifyResearchCapture([], encodeResearchCapture(seal)))).toBe(true)
  const incomplete = { ...seal, observedReceipts: 4, invalidations: [CaptureInvalidation.Overflow] }
  expect(Result.getOrThrow(verifyResearchCapture([bytes], encodeResearchCapture(incomplete))).complete).toBe(false)
  const reordered = encodeResearchCapture({ ...chunk, receipts: [...chunk.receipts].reverse() })
  expect(
    Result.isFailure(
      verifyResearchCapture([reordered], encodeResearchCapture({ ...seal, lastContentHash: reordered.contentHash })),
    ),
  ).toBe(true)
})

test('metadata seals cannot advertise qualified completeness or accept oversized payloads', () => {
  const { bytes, seal } = captureFixture()
  for (const qualification of [undefined, 'ACKNOWLEDGED', 'QUALIFIED']) {
    const payload = JSON.stringify({ ...seal, qualification })
    expect(Result.isFailure(decodeResearchCaptureSeal({ payload, contentHash: sha256(payload) }))).toBe(true)
  }
  const payload = bytes.payload + ' '.repeat(maximumResearchCaptureChunkBytes - Buffer.byteLength(bytes.payload))
  expect(Result.isSuccess(decodeResearchCaptureChunk({ payload, contentHash: sha256(payload) }))).toBe(true)
  const oversized = `${payload} `
  expect(Result.isFailure(decodeResearchCaptureChunk({ payload: oversized, contentHash: sha256(oversized) }))).toBe(
    true,
  )
})

test('one capture cannot merge worker epochs or accept missing raw-byte identity', () => {
  for (const event of [
    { ...marketEvent, consumerEpoch: 'another-worker' },
    { ...marketEvent, consumerSequence: 2 },
    { ...marketEvent, rawValueSha256: null },
    { ...marketEvent, tombstone: true },
  ]) {
    const { chunk, seal } = captureFixture()
    const changed = encodeResearchCapture({
      ...chunk,
      receipts: chunk.receipts.map((receipt, index) => (index === 1 ? { ...receipt, event } : receipt)),
    })
    expect(
      Result.isFailure(
        verifyResearchCapture([changed], encodeResearchCapture({ ...seal, lastContentHash: changed.contentHash })),
      ),
    ).toBe(true)
  }
})

test('faulty capture observers cannot throw into execution', () => {
  expect(() =>
    recordResearchCapture(
      {
        record: () => {
          throw new Error('capture failed')
        },
        invalidate: () => {
          throw new Error('invalidation failed')
        },
      },
      marketEvent,
      100,
    ),
  ).not.toThrow()
})

test('observers cannot mutate native bootstrap boundaries or position objects', () => {
  const positions = [{ topic: 'quotes', partition: 0, offset: '0' }]
  const bootstrap = {
    schemaVersion: 'bayn.kafka-bootstrap.v1' as const,
    epoch: 'consumer-1',
    observedAtMs: 100,
    lowerTimestampMs: 0,
    timestampPolicy: KafkaBootstrapTimestampPolicy.RetainedBeginning,
    partitions: [{ topic: 'quotes', partition: 0, logStartOffset: '0', startOffset: '0', endOffset: '10' }],
  }
  const event: ResearchCaptureEvent = {
    kind: 'consumer-boundary',
    consumerEpoch: 'consumer-1',
    phase: 'ASSIGNED',
    positions,
    bootstrap,
  }
  const invalidations: CaptureInvalidation[] = []
  for (const target of ['position', 'bootstrap'] as const) {
    recordResearchCapture(
      {
        record: (received) => {
          expect(received).not.toBe(event)
          if (received.kind !== 'consumer-boundary') throw new Error('Missing boundary fixture')
          const value = target === 'position' ? received.positions[0] : received.bootstrap?.partitions[0]
          if (value === undefined) throw new Error('Missing native position fixture')
          expect(Object.isFrozen(value)).toBe(true)
          Object.assign(value, { offset: '999', endOffset: '999' })
        },
        invalidate: (reason) => {
          invalidations.push(reason)
        },
      },
      event,
      100,
    )
  }
  expect(positions[0]?.offset).toBe('0')
  expect(bootstrap.partitions[0]?.endOffset).toBe('10')
  expect(invalidations).toEqual([CaptureInvalidation.InvalidEvent, CaptureInvalidation.InvalidEvent])
})

test('property: changed bytes and truncated chunk chains cannot retain the original seal', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 300 }), (suffix) => {
      const { bytes, seal } = captureFixture()
      expect(
        Result.isFailure(
          verifyResearchCapture([{ ...bytes, payload: bytes.payload + suffix }], encodeResearchCapture(seal)),
        ),
      ).toBe(true)
      expect(Result.isFailure(verifyResearchCapture([], encodeResearchCapture(seal)))).toBe(true)
    }),
    { numRuns: 1000 },
  )
})
