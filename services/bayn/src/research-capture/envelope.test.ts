import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import fc from 'fast-check'

import { sha256 } from '../hash'
import {
  CaptureQualification,
  captureKafkaTransport,
  encodeResearchCapture,
  maximumResearchCaptureChunkBytes,
  type ResearchCaptureChunk,
  type ResearchCaptureSeal,
} from './capture'
import { captureEvent, marketEvent } from './capture.test-support'
import {
  buildResearchCaptureExportEnvelope,
  decodeResearchCaptureExportEnvelope,
  deriveResearchCaptureExportManifest,
  persistResearchCaptureExportEnvelope,
  researchCaptureExportEntryReservation,
  researchCaptureExportEnvelopeReservation,
  researchCaptureObject,
  verifyResearchCaptureExport,
  type ResearchCaptureObject,
} from './export'

const fixture = (values: readonly (Uint8Array | null)[] = [Buffer.from('é'), Buffer.alloc(0), null]) => {
  const entries = [
    { receipt: { sequence: 1, observedAtMs: 100, event: captureEvent('STARTED') } },
    ...values.map((rawValue, index) => ({
      rawValue,
      receipt: {
        sequence: index + 2,
        observedAtMs: 100,
        event: {
          ...marketEvent,
          originalTransport: captureKafkaTransport(100),
          consumerSequence: index + 1,
          offset: String(index),
          tombstone: rawValue === null,
          rawValueSha256: rawValue === null ? null : sha256(rawValue),
          rawByteLength: rawValue?.byteLength ?? null,
        },
      },
    })),
    { receipt: { sequence: values.length + 2, observedAtMs: 100, event: captureEvent('STOPPED') } },
  ]
  const chunk: ResearchCaptureChunk = {
    schemaVersion: 'bayn.research-capture-chunk.v1',
    captureId: 'envelope-fixture',
    sourceRevision: 'a'.repeat(40),
    chunkOrdinal: 0,
    previousContentHash: null,
    receipts: entries.map((entry) => entry.receipt),
  }
  const metadata = encodeResearchCapture(chunk)
  const envelope = buildResearchCaptureExportEnvelope(chunk, metadata, entries, null)
  const sealFor = (object: ResearchCaptureObject) => {
    const seal: ResearchCaptureSeal = {
      schemaVersion: 'bayn.research-capture-seal.v1',
      qualification: CaptureQualification.Unqualified,
      captureId: chunk.captureId,
      sourceRevision: chunk.sourceRevision,
      closedAtMs: 100,
      observedReceipts: entries.length,
      persistedReceipts: entries.length,
      persistedChunks: 1,
      lastContentHash: metadata.contentHash,
      invalidations: [],
      exportRoot: {
        schemaVersion: 'bayn.research-capture-export-root.v2',
        exportedChunks: 1,
        lastIndexHash: object.contentHash,
      },
    }
    const bytes = encodeResearchCapture(seal)
    const manifest = Result.getOrThrow(deriveResearchCaptureExportManifest(bytes))
    return {
      seal: bytes,
      manifest: { contentHash: manifest.contentHash, payload: Buffer.from(manifest.payload).toString('utf8') },
    }
  }
  return { chunk, entries, metadata, envelope, sealFor }
}

const replaceHeader = (object: ResearchCaptureObject, mutate: (header: Record<string, unknown>) => void) => {
  const original = Buffer.from(object.payload)
  const length = original.readUInt32BE(8)
  const header = JSON.parse(original.subarray(12, 12 + length).toString('utf8')) as Record<string, unknown>
  mutate(header)
  const changed = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.from(original.subarray(0, 12))
  prefix.writeUInt32BE(changed.byteLength, 8)
  return researchCaptureObject(Buffer.concat([prefix, changed, original.subarray(12 + length)]))
}

test('one envelope verifies exact metadata and binary bytes with one durable object call', async () => {
  const f = fixture([Buffer.from([0, 255, 128]), Buffer.from('é'), Buffer.alloc(0), null])
  const decoded = Result.getOrThrow(decodeResearchCaptureExportEnvelope(f.envelope))
  expect(decoded.metadata).toEqual(f.metadata)
  expect(decoded.raw).toEqual(Buffer.from([0, 255, 128, 195, 169]))
  const { seal, manifest } = f.sealFor(f.envelope)
  expect(Result.getOrThrow(verifyResearchCaptureExport([decoded], seal, manifest)).exportVerified).toBe(true)
  const calls: ResearchCaptureObject[] = []
  const hash = await Effect.runPromise(
    persistResearchCaptureExportEnvelope(
      {
        putVerified: (object) =>
          Effect.sync(() => {
            calls.push(object)
          }),
      },
      f.envelope,
    ),
  )
  expect(calls).toEqual([f.envelope])
  expect(hash).toBe(f.envelope.contentHash)
})

test.each([
  'short',
  'magic',
  'zero-header',
  'huge-header',
  'truncated-header',
  'truncated-body',
  'trailing',
  'raw-corrupt',
  'hash',
] as const)('envelope rejects %s framing before returning components', (fault) => {
  const f = fixture()
  let payload = Buffer.from(f.envelope.payload)
  if (fault === 'short') payload = payload.subarray(0, 11)
  if (fault === 'magic') payload[0] = 0
  if (fault === 'zero-header') payload.writeUInt32BE(0, 8)
  if (fault === 'huge-header') payload.writeUInt32BE(0xffffffff, 8)
  if (fault === 'truncated-header') payload = payload.subarray(0, 13)
  if (fault === 'truncated-body') payload = payload.subarray(0, -1)
  if (fault === 'trailing') payload = Buffer.concat([payload, Buffer.from([0])])
  if (fault === 'raw-corrupt') payload[payload.length - 1] = 0
  const changed = fault === 'hash' ? { ...f.envelope, contentHash: '0'.repeat(64) } : researchCaptureObject(payload)
  expect(Result.isFailure(decodeResearchCaptureExportEnvelope(changed))).toBe(true)
})

test.each(['format', 'negative-length', 'component-hash', 'unknown-field'] as const)(
  'envelope rejects %s header',
  (fault) => {
    const f = fixture()
    const changed = replaceHeader(f.envelope, (header) => {
      if (fault === 'format') header['schemaVersion'] = 'bayn.research-capture-byte-index.v1'
      if (fault === 'negative-length') header['metadata'] = { ...(header['metadata'] as object), byteLength: -1 }
      if (fault === 'component-hash') header['raw'] = { ...(header['raw'] as object), contentHash: '0'.repeat(64) }
      if (fault === 'unknown-field') header['extra'] = true
    })
    expect(Result.isFailure(decodeResearchCaptureExportEnvelope(changed))).toBe(true)
  },
)

test('v2 verification rejects missing envelopes, component substitution and mixed chains', () => {
  const f = fixture()
  const decoded = Result.getOrThrow(decodeResearchCaptureExportEnvelope(f.envelope))
  const { seal, manifest } = f.sealFor(f.envelope)
  const { envelope: _envelope, ...missing } = decoded
  expect(Result.isFailure(verifyResearchCaptureExport([missing], seal, manifest))).toBe(true)
  expect(
    Result.isFailure(
      verifyResearchCaptureExport([{ ...decoded, raw: undefined as unknown as Uint8Array }], seal, manifest),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(verifyResearchCaptureExport([{ ...decoded, raw: Buffer.from('different') }], seal, manifest)),
  ).toBe(true)
  const legacySeal = encodeResearchCapture({
    ...JSON.parse(seal.payload),
    exportRoot: { ...JSON.parse(seal.payload).exportRoot, schemaVersion: 'bayn.research-capture-export-root.v1' },
  })
  const legacyManifest = Result.getOrThrow(deriveResearchCaptureExportManifest(legacySeal))
  expect(
    Result.isFailure(
      verifyResearchCaptureExport([decoded], legacySeal, {
        contentHash: legacyManifest.contentHash,
        payload: Buffer.from(legacyManifest.payload).toString('utf8'),
      }),
    ),
  ).toBe(true)
})

test.each(['missing-range', 'offset', 'tombstone', 'predecessor'] as const)(
  'v2 verification rejects rehashed %s corruption',
  (fault) => {
    const f = fixture()
    const changed = replaceHeader(f.envelope, (header) => {
      const ranges = header['ranges'] as Array<Record<string, unknown>>
      if (fault === 'missing-range') ranges.pop()
      if (fault === 'offset') ranges[0] = { ...ranges[0], byteOffset: 1 }
      if (fault === 'tombstone') ranges[2] = { ...ranges[2], byteOffset: 2, byteLength: 0 }
      if (fault === 'predecessor') header['previousIndexHash'] = 'b'.repeat(64)
    })
    const decoded = Result.getOrThrow(decodeResearchCaptureExportEnvelope(changed))
    const { seal, manifest } = f.sealFor(changed)
    expect(Result.isFailure(verifyResearchCaptureExport([decoded], seal, manifest))).toBe(true)
  },
)

test('envelope rejects invalid UTF8 and oversized input without an unbounded allocation', () => {
  const f = fixture()
  const payload = Buffer.from(f.envelope.payload)
  payload[12] = 0xff
  expect(Result.isFailure(decodeResearchCaptureExportEnvelope(researchCaptureObject(payload)))).toBe(true)
  const invalidMetadata = Buffer.from(f.envelope.payload)
  const metadataStart = 12 + invalidMetadata.readUInt32BE(8)
  invalidMetadata[metadataStart] = 0xff
  const invalidUtf8 = replaceHeader(researchCaptureObject(invalidMetadata), (header) => {
    const metadata = header['metadata'] as { contentHash: string; byteLength: number }
    metadata.contentHash = sha256(invalidMetadata.subarray(metadataStart, metadataStart + metadata.byteLength))
  })
  expect(Result.isFailure(decodeResearchCaptureExportEnvelope(invalidUtf8))).toBe(true)
  expect(
    Result.isFailure(
      decodeResearchCaptureExportEnvelope(researchCaptureObject(Buffer.alloc(maximumResearchCaptureChunkBytes + 1))),
    ),
  ).toBe(true)
  const raw = Buffer.alloc(maximumResearchCaptureChunkBytes)
  expect(() => fixture([raw])).toThrow('Envelope exceeds its framing or object reservation')
  expect(() =>
    buildResearchCaptureExportEnvelope(f.chunk, { ...f.metadata, contentHash: '0'.repeat(64) }, f.entries, null),
  ).toThrow()
})

test('property: exact arbitrary bytes and peak framing/readback copies fit unchanged admission reservations', () => {
  fc.assert(
    fc.property(fc.array(fc.option(fc.uint8Array({ maxLength: 2048 }), { nil: null }), { maxLength: 24 }), (values) => {
      const f = fixture(values)
      const decoded = Result.getOrThrow(decodeResearchCaptureExportEnvelope(f.envelope))
      const { seal, manifest } = f.sealFor(f.envelope)
      expect(Result.getOrThrow(verifyResearchCaptureExport([decoded], seal, manifest)).exportVerified).toBe(true)
      const receiptBytes = f.entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.receipt)), 0)
      const rawBytes = values.reduce((sum, value) => sum + (value?.byteLength ?? 0), 0)
      const reservation =
        researchCaptureExportEnvelopeReservation +
        f.entries.reduce(
          (sum, entry) =>
            sum +
            researchCaptureExportEntryReservation(
              Buffer.byteLength(JSON.stringify(entry.receipt)),
              'rawValue' in entry ? (entry.rawValue?.byteLength ?? 0) : 0,
            ),
          0,
        )
      const metadataBytes = Buffer.byteLength(f.metadata.payload)
      const headerBytes = Buffer.from(f.envelope.payload).readUInt32BE(8)
      const assemblyPeak = receiptBytes + metadataBytes + rawBytes + f.envelope.payload.byteLength + headerBytes
      const readbackPeak = receiptBytes + metadataBytes + rawBytes + 2 * f.envelope.payload.byteLength
      expect(Math.max(assemblyPeak, readbackPeak)).toBeLessThanOrEqual(reservation)
      expect(decoded.raw).toEqual(Buffer.concat(values.filter((value): value is Uint8Array => value !== null)))
    }),
    { numRuns: 100 },
  )
})
