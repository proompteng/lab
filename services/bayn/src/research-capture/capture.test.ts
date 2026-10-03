import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { captureEvent, marketEvent } from './capture.test-support'
import {
  CaptureInvalidation,
  encodeResearchCapture,
  recordResearchCapture,
  verifyResearchCapture,
  type ResearchCaptureChunk,
  type ResearchCaptureSeal,
} from './capture'

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

test('sealed receipts bind exact bytes, consumer order, and the complete observed tail', () => {
  const { chunk, bytes, seal } = captureFixture()
  expect(Result.getOrThrow(verifyResearchCapture([bytes], encodeResearchCapture(seal))).complete).toBe(true)
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
