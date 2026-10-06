import { createHash } from 'node:crypto'
import { Effect, Result, Schema } from 'effect'

import { sha256 } from '../hash'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  strictParseOptions,
} from '../schemas'
import {
  CaptureQualification,
  ResearchCaptureFailure,
  ResearchCaptureIdSchema,
  decodeResearchCaptureChunk,
  decodeResearchCaptureSeal,
  maximumResearchCaptureChunkBytes,
  verifyResearchCapture,
  verifyResearchCapturePrefix,
  type ResearchCaptureBytes,
  type ResearchCaptureChunk,
  type ResearchCaptureReceipt,
} from './capture'

export interface ResearchCaptureObject {
  readonly contentHash: string
  readonly payload: Uint8Array
}

export interface ResearchCaptureObjectStore {
  readonly putVerified: (object: ResearchCaptureObject) => Effect.Effect<void, ResearchCaptureFailure>
}

export interface ResearchCaptureExportEntry {
  readonly receipt: ResearchCaptureReceipt
  readonly rawValue?: Uint8Array | null
}

const ObjectReferenceSchema = Schema.Struct({
  contentHash: Sha256Schema,
  byteLength: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(maximumResearchCaptureChunkBytes)),
})
const ByteRangeSchema = Schema.Struct({
  receiptSequence: PositiveIntegerSchema,
  byteOffset: Schema.NullOr(NonNegativeIntegerSchema),
  byteLength: Schema.NullOr(NonNegativeIntegerSchema),
})
export const ResearchCaptureByteIndexSchema = Schema.Struct({
  schemaVersion: Schema.Union([
    Schema.Literal('bayn.research-capture-byte-index.v1'),
    Schema.Literal('bayn.research-capture-envelope.v2'),
  ]),
  qualification: Schema.Enum(CaptureQualification),
  captureId: ResearchCaptureIdSchema,
  sourceRevision: GitSourceRevisionSchema,
  chunkOrdinal: NonNegativeIntegerSchema,
  previousIndexHash: Schema.NullOr(Sha256Schema),
  metadata: ObjectReferenceSchema,
  raw: ObjectReferenceSchema,
  ranges: Schema.Array(ByteRangeSchema).check(Schema.isMaxLength(1024)),
})
export const ResearchCaptureExportManifestSchema = Schema.Struct({
  schemaVersion: Schema.Union([
    Schema.Literal('bayn.research-capture-export.v1'),
    Schema.Literal('bayn.research-capture-export.v2'),
  ]),
  qualification: Schema.Enum(CaptureQualification),
  captureId: ResearchCaptureIdSchema,
  sourceRevision: GitSourceRevisionSchema,
  exportedChunks: NonNegativeIntegerSchema,
  lastIndexHash: Schema.NullOr(Sha256Schema),
  metadataSeal: ObjectReferenceSchema,
})

// Reserve wire payloads, including assembly and readback, rather than claiming a bound on JavaScript or SDK RSS.
export const researchCaptureExportEnvelopeReservation = 64 * 1024
export const researchCaptureExportEntryReservation = (receiptBytes: number, rawBytes: number): number =>
  4 * receiptBytes + 3 * rawBytes + 4 * 128

export const researchCaptureObject = (payload: string | Uint8Array): ResearchCaptureObject => {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  return { contentHash: sha256(bytes), payload: bytes }
}
export const researchCaptureObjectKey = (contentHash: string): string => `research-capture/sha256/${contentHash}`
const reference = (object: ResearchCaptureObject) => ({
  contentHash: object.contentHash,
  byteLength: object.payload.byteLength,
})
const fail = (message: string) => new ResearchCaptureFailure({ message })

const envelopeMagic = Buffer.from('BAYNCAP2')
const envelopePrefixBytes = 12
const envelopeFixedHeaderBytes = 4096
const envelopeMaximumHeaderBytes = envelopeFixedHeaderBytes + 128 * 1024

/** One immutable write unit. Its own hash is external, so neither metadata nor predecessor links are circular. */
export const buildResearchCaptureExportEnvelope = (
  chunk: ResearchCaptureChunk,
  metadataBytes: ResearchCaptureBytes,
  entries: readonly ResearchCaptureExportEntry[],
  previousIndexHash: string | null,
): ResearchCaptureObject => {
  if (entries.length > 1024) throw fail('Envelope exceeds its receipt bound')
  const parts: Uint8Array[] = []
  const ranges: Array<typeof ByteRangeSchema.Type> = []
  const rawDigest = createHash('sha256')
  let rawLength = 0
  for (const entry of entries) {
    if (entry.receipt.event.kind !== 'market-record') continue
    const raw = entry.rawValue
    if (raw === undefined) throw fail('Admitted market receipt lost its original bytes')
    const range = {
      receiptSequence: entry.receipt.sequence,
      byteOffset: raw === null ? null : rawLength,
      byteLength: raw === null ? null : raw.byteLength,
    }
    // The comma is charged too; fixed array/header punctuation is charged to the envelope reserve.
    if (Buffer.byteLength(JSON.stringify(range)) + 1 > 128) throw fail('Byte range exceeds its admission reservation')
    ranges.push(range)
    if (raw !== null) {
      parts.push(raw)
      rawLength += raw.byteLength
      if (rawLength > maximumResearchCaptureChunkBytes) throw fail('Envelope raw bytes exceed the object bound')
      rawDigest.update(raw)
    }
  }
  const metadataLength = Buffer.byteLength(metadataBytes.payload, 'utf8')
  if (metadataLength > maximumResearchCaptureChunkBytes || sha256(metadataBytes.payload) !== metadataBytes.contentHash)
    throw fail('Envelope metadata differs from its content address or byte bound')
  const header = {
    schemaVersion: 'bayn.research-capture-envelope.v2' as const,
    qualification: CaptureQualification.Unqualified,
    captureId: chunk.captureId,
    sourceRevision: chunk.sourceRevision,
    chunkOrdinal: chunk.chunkOrdinal,
    previousIndexHash,
    metadata: { contentHash: metadataBytes.contentHash, byteLength: metadataLength },
    raw: { contentHash: rawDigest.digest('hex'), byteLength: rawLength },
    ranges,
  } satisfies typeof ResearchCaptureByteIndexSchema.Type
  const headerText = JSON.stringify(header)
  const headerLength = Buffer.byteLength(headerText)
  const fixedHeaderLength = Buffer.byteLength(JSON.stringify({ ...header, ranges: [] })) + envelopePrefixBytes
  const total = envelopePrefixBytes + headerLength + metadataLength + rawLength
  if (
    fixedHeaderLength > envelopeFixedHeaderBytes ||
    headerLength > envelopeFixedHeaderBytes + 128 * entries.length ||
    total > maximumResearchCaptureChunkBytes
  )
    throw fail('Envelope exceeds its framing or object reservation')
  // One bounded allocation, with no temporary metadata Buffer or separately concatenated raw buffer.
  // Construction fits 4M+2R+4I; full readback fits 4M+3R+4I, including admitted bytes.
  const payload = Buffer.allocUnsafe(total)
  envelopeMagic.copy(payload)
  payload.writeUInt32BE(headerLength, envelopeMagic.byteLength)
  let offset = envelopePrefixBytes
  offset += payload.write(headerText, offset, headerLength, 'utf8')
  offset += payload.write(metadataBytes.payload, offset, metadataLength, 'utf8')
  for (const part of parts) {
    payload.set(part, offset)
    offset += part.byteLength
  }
  if (offset !== total) throw fail('Envelope assembly did not fill its exact byte bound')
  return researchCaptureObject(payload)
}

/** Decode bounded framing without parsing/re-encoding the authoritative metadata bytes. */
export const decodeResearchCaptureExportEnvelope = (envelope: ResearchCaptureObject) =>
  Result.gen(function* () {
    if (
      !(envelope.payload instanceof Uint8Array) ||
      envelope.payload.byteLength < envelopePrefixBytes ||
      envelope.payload.byteLength > maximumResearchCaptureChunkBytes ||
      sha256(envelope.payload) !== envelope.contentHash
    )
      return yield* Result.fail(fail('Envelope exceeds its byte bound or differs from its content address'))
    const payload = Buffer.from(envelope.payload.buffer, envelope.payload.byteOffset, envelope.payload.byteLength)
    if (!payload.subarray(0, envelopeMagic.byteLength).equals(envelopeMagic))
      return yield* Result.fail(fail('Unknown capture envelope framing'))
    const headerLength = payload.readUInt32BE(envelopeMagic.byteLength)
    if (
      headerLength > envelopeMaximumHeaderBytes ||
      headerLength === 0 ||
      envelopePrefixBytes + headerLength > payload.byteLength
    )
      return yield* Result.fail(fail('Capture envelope has an invalid header length'))
    const headerText = yield* Result.try({
      try: () =>
        new TextDecoder('utf-8', { fatal: true }).decode(
          payload.subarray(envelopePrefixBytes, envelopePrefixBytes + headerLength),
        ),
      catch: () => fail('Capture envelope header is not exact UTF8'),
    })
    const header = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(ResearchCaptureByteIndexSchema),
      strictParseOptions,
    )(headerText)
    if (header.schemaVersion !== 'bayn.research-capture-envelope.v2')
      return yield* Result.fail(fail('Capture envelope has the wrong format discriminator'))
    const metadataStart = envelopePrefixBytes + headerLength
    const rawStart = metadataStart + header.metadata.byteLength
    if (rawStart + header.raw.byteLength !== payload.byteLength)
      return yield* Result.fail(fail('Capture envelope is truncated or has trailing bytes'))
    const metadataPayload = payload.subarray(metadataStart, rawStart)
    const raw = payload.subarray(rawStart)
    if (sha256(metadataPayload) !== header.metadata.contentHash || sha256(raw) !== header.raw.contentHash)
      return yield* Result.fail(fail('Capture envelope component differs from its exact hash'))
    const metadataText = yield* Result.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(metadataPayload),
      catch: () => fail('Capture envelope metadata is not exact UTF8'),
    })
    return {
      envelope,
      metadata: { contentHash: header.metadata.contentHash, payload: metadataText },
      index: { contentHash: sha256(headerText), payload: headerText },
      raw,
    }
  })

export const persistResearchCaptureExportEnvelope = (
  store: ResearchCaptureObjectStore,
  envelope: ResearchCaptureObject,
) => store.putVerified(envelope).pipe(Effect.as(envelope.contentHash))

export const deriveResearchCaptureExportManifest = (sealBytes: ResearchCaptureBytes | undefined) =>
  Result.gen(function* () {
    if (sealBytes === undefined) return yield* Result.fail(fail('Unsealed capture has no durable export root'))
    const seal = yield* decodeResearchCaptureSeal(sealBytes)
    const root = seal.exportRoot
    if (root === undefined) return yield* Result.fail(fail('Metadata-only seal has no durable export root'))
    const metadataSeal = researchCaptureObject(sealBytes.payload)
    return researchCaptureObject(
      JSON.stringify({
        schemaVersion:
          root.schemaVersion === 'bayn.research-capture-export-root.v2'
            ? 'bayn.research-capture-export.v2'
            : 'bayn.research-capture-export.v1',
        qualification: CaptureQualification.Unqualified,
        captureId: seal.captureId,
        sourceRevision: seal.sourceRevision,
        exportedChunks: root.exportedChunks,
        lastIndexHash: root.lastIndexHash,
        metadataSeal: reference(metadataSeal),
      } satisfies typeof ResearchCaptureExportManifestSchema.Type),
    )
  })

export const persistResearchCaptureExportSeal = (store: ResearchCaptureObjectStore, sealBytes: ResearchCaptureBytes) =>
  Effect.gen(function* () {
    const manifest = yield* Effect.fromResult(deriveResearchCaptureExportManifest(sealBytes)).pipe(
      Effect.mapError((cause) => new ResearchCaptureFailure({ message: 'Invalid capture export root', cause })),
    )
    yield* store.putVerified(researchCaptureObject(sealBytes.payload))
    yield* store.putVerified(manifest)
    return manifest.contentHash
  })

const decodeExport = <A>(schema: Schema.Codec<A>, bytes: ResearchCaptureBytes) =>
  Result.gen(function* () {
    if (
      Buffer.byteLength(bytes.payload) > maximumResearchCaptureChunkBytes ||
      sha256(bytes.payload) !== bytes.contentHash
    )
      return yield* Result.fail(fail('Export object exceeds its byte bound or has a different hash'))
    return yield* Schema.decodeUnknownResult(Schema.fromJsonString(schema), strictParseOptions)(bytes.payload)
  })

/** Readback proves these objects, never missing source coverage or trading authority. */
const verifyExport = (
  chunks: readonly {
    readonly index: ResearchCaptureBytes
    readonly metadata: ResearchCaptureBytes
    readonly raw: Uint8Array
    readonly envelope?: ResearchCaptureObject
  }[],
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
  prefix: boolean,
) =>
  Result.gen(function* () {
    const capture = yield* (prefix ? verifyResearchCapturePrefix : verifyResearchCapture)(
      chunks.map((chunk) => chunk.metadata),
      sealBytes,
    )
    const manifest = yield* decodeExport(ResearchCaptureExportManifestSchema, manifestBytes)
    const expectedManifest = yield* deriveResearchCaptureExportManifest(sealBytes)
    if (
      manifestBytes.contentHash !== expectedManifest.contentHash ||
      manifestBytes.payload !== Buffer.from(expectedManifest.payload).toString('utf8')
    )
      return yield* Result.fail(fail('Export manifest differs from its durable SQL seal root'))
    if (
      manifest.captureId !== capture.seal.captureId ||
      manifest.sourceRevision !== capture.seal.sourceRevision ||
      manifest.exportedChunks !== chunks.length ||
      manifest.metadataSeal.contentHash !== sealBytes.contentHash ||
      manifest.metadataSeal.byteLength !== Buffer.byteLength(sealBytes.payload)
    )
      return yield* Result.fail(fail('Export manifest does not bind its exact metadata seal'))
    let previousIndexHash: string | null = null
    for (const [ordinal, bytes] of chunks.entries()) {
      const envelopeFormat = manifest.schemaVersion === 'bayn.research-capture-export.v2'
      if (envelopeFormat) {
        if (bytes.envelope === undefined) return yield* Result.fail(fail('Envelope export omits its immutable frame'))
        const extracted = yield* decodeResearchCaptureExportEnvelope(bytes.envelope)
        if (
          !(bytes.raw instanceof Uint8Array) ||
          extracted.metadata.payload !== bytes.metadata.payload ||
          extracted.metadata.contentHash !== bytes.metadata.contentHash ||
          extracted.index.payload !== bytes.index.payload ||
          extracted.index.contentHash !== bytes.index.contentHash ||
          !Buffer.from(extracted.raw.buffer, extracted.raw.byteOffset, extracted.raw.byteLength).equals(bytes.raw)
        )
          return yield* Result.fail(fail('Export components differ from their immutable envelope'))
      } else if (bytes.envelope !== undefined) {
        return yield* Result.fail(fail('Legacy export unexpectedly contains an envelope'))
      }
      const index = yield* decodeExport(ResearchCaptureByteIndexSchema, bytes.index)
      const metadata = yield* decodeResearchCaptureChunk(bytes.metadata)
      if (
        index.schemaVersion !==
          (envelopeFormat ? 'bayn.research-capture-envelope.v2' : 'bayn.research-capture-byte-index.v1') ||
        index.captureId !== manifest.captureId ||
        index.sourceRevision !== manifest.sourceRevision ||
        index.chunkOrdinal !== ordinal ||
        index.previousIndexHash !== previousIndexHash ||
        index.metadata.contentHash !== bytes.metadata.contentHash ||
        index.metadata.byteLength !== Buffer.byteLength(bytes.metadata.payload) ||
        !(bytes.raw instanceof Uint8Array) ||
        bytes.raw.byteLength > maximumResearchCaptureChunkBytes ||
        index.raw.byteLength !== bytes.raw.byteLength ||
        index.raw.contentHash !== sha256(bytes.raw)
      )
        return yield* Result.fail(fail('Export index identity, chain, or referenced object differs'))
      const markets = metadata.receipts.filter((receipt) => receipt.event.kind === 'market-record')
      if (markets.length !== index.ranges.length) return yield* Result.fail(fail('Export ranges omit market receipts'))
      let offset = 0
      for (const [position, receipt] of markets.entries()) {
        const range = index.ranges[position]
        const event = receipt.event
        if (event.kind !== 'market-record' || range === undefined || range.receiptSequence !== receipt.sequence)
          return yield* Result.fail(fail('Export range does not belong to its original receipt'))
        if (event.originalTransport === undefined)
          return yield* Result.fail(fail('Raw export omits the original transport timestamp contract'))
        if (event.tombstone) {
          if (range.byteOffset !== null || range.byteLength !== null)
            return yield* Result.fail(fail('Tombstone has a byte range'))
        } else {
          if (
            range.byteOffset !== offset ||
            range.byteLength !== event.rawByteLength ||
            range.byteLength === null ||
            offset + range.byteLength > bytes.raw.byteLength ||
            sha256(bytes.raw.subarray(offset, offset + range.byteLength)) !== event.rawValueSha256
          )
            return yield* Result.fail(fail('Export range changed original Kafka bytes'))
          offset += range.byteLength
        }
      }
      if (offset !== bytes.raw.byteLength) return yield* Result.fail(fail('Export contains unreferenced raw bytes'))
      previousIndexHash = bytes.envelope?.contentHash ?? bytes.index.contentHash
    }
    if (manifest.lastIndexHash !== previousIndexHash)
      return yield* Result.fail(fail('Export manifest omits its index tail'))
    return { ...capture, exportVerified: true, complete: false }
  })

export const verifyResearchCaptureExport = (
  chunks: Parameters<typeof verifyExport>[0],
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
) => verifyExport(chunks, sealBytes, manifestBytes, false)

/** An immutable observation prefix can end while its consumer continues. It is not a closed worker. */
export const verifyResearchCaptureExportPrefix = (
  chunks: Parameters<typeof verifyExport>[0],
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
) => verifyExport(chunks, sealBytes, manifestBytes, true)
