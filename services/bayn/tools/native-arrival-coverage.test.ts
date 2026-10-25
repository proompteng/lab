import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import { makeNativeArrivalChunk, nativeArrival, type NativeArrival } from '../src/market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture,
  nativeArrivalObservationFixture,
} from '../src/market-data/streaming/native-arrival.test-support'
import { captureKafkaTransport, CaptureDisposition } from '../src/market-data/streaming/transport-evidence'
import { auditNativeArrivalCoverage } from './native-arrival-coverage'

const epoch = nativeArrivalEpochFixture
const records = Array.from({ length: 4 }, (_, index) => {
  const at = new Date(900 + index * 10).toISOString()
  const value = JSON.stringify({
    provider: 'alpaca',
    feed: 'us',
    delayClass: 'real_time_crypto',
    marketSession: 'continuous',
    channel: 'quotes',
    seq: index + 1,
    symbol: 'BTC/USD',
    version: 2,
    eventTs: at,
    ingestTs: at,
    payload: { T: 'q', S: 'BTC/USD', t: at, bp: 100 + index, bs: 2, ap: 101 + index, as: 3 },
  })
  return nativeArrival(epoch, {
    ...nativeArrivalObservationFixture(index + 1, value),
    availableAtMs: 1000 + index * 10,
  })
})

const fixture = (arrivals: readonly NativeArrival[] = records) => {
  let previous: string | null = null
  const chunks = arrivals.map((record, ordinal) => {
    const chunk = Result.getOrThrow(makeNativeArrivalChunk(epoch, ordinal, previous, [record]))
    previous = chunk.contentHash
    return {
      header: chunk.header,
      contentHash: chunk.contentHash,
      compressedBase64: Buffer.from(chunk.compressed).toString('base64'),
    }
  })
  const final = chunks.at(-1)
  if (final === undefined) throw new Error('Expected fixture chunks')
  return {
    epoch: { epoch, contentHash: Result.getOrThrow(canonicalHashV1Result(epoch)) },
    headers: chunks.map(({ contentHash, header }) => ({ contentHash, header })),
    chunks,
    end: {
      captureId: epoch.captureId,
      status: 'STOPPED' as const,
      observedConsumerSequence: arrivals.length,
      durableConsumerSequence: arrivals.length,
      lastChunkHash: final.contentHash,
      reason: null,
      consumerScopeCompleted: false,
    },
    interval: { startMs: 1005, endMs: 1025 },
    symbols: ['BTC/USD'],
  }
}

test('audits exact original quote bytes without claiming controller, execution or complete capture coverage', () => {
  const input = fixture()
  const original = JSON.stringify(input)
  const result = Result.getOrThrow(auditNativeArrivalCoverage(input))
  expect(result.report).toMatchObject({
    diagnosticOnly: true,
    qualification: 'UNQUALIFIED',
    verifiedHeaderCount: 4,
    verifiedRecords: 4,
    decodedChunkRange: { first: 0, last: 3 },
    completePrefixBytesVerified: true,
    controllerCoverage: 'UNKNOWN',
    decisionCommitAcknowledgement: 'UNKNOWN',
    endReceipt: { consumerScopeCompleted: false },
    symbols: [
      {
        symbol: 'BTC/USD',
        observedQuoteCount: 2,
        initialQuoteAvailableAtMs: 1000,
        firstQuoteAvailableAtMs: 1010,
        lastQuoteAvailableAtMs: 1020,
        maximumQuoteArrivalGapIncludingBoundariesMs: 10,
      },
    ],
  })
  expect(result.quotes.map((quote) => quote.availableAtMs)).toEqual([1000, 1010, 1020, 1030])
  expect(result.quotes.map((quote) => quote.sequence)).toEqual(
    records.map((record) => record.receipt.projectionSequence),
  )
  expect(result.quotes.map((quote) => quote.recordHash)).toEqual(
    records.map((record) => {
      if (record.receipt.rawValueSha256 === null) throw new Error('Expected raw quote identity')
      return record.receipt.rawValueSha256
    }),
  )
  expect(result.quotes[0]?.value).toMatchObject({
    bidPrice: 100,
    askPrice: 101,
    bidSize: 2,
    askSize: 3,
    sourceOffset: '0',
  })
  expect(JSON.stringify(input)).toBe(original)
  expect(Result.getOrThrow(auditNativeArrivalCoverage(input))).toEqual(result)
})

test('distinguishes verified bounded interval bytes from unverified earlier and later payloads', () => {
  const input = fixture()
  const result = Result.getOrThrow(
    auditNativeArrivalCoverage({
      ...input,
      chunks: input.chunks.slice(1, 3),
      interval: { startMs: 1011, endMs: 1019 },
    }),
  )
  expect(result.report).toMatchObject({
    completePrefixBytesVerified: false,
    decodedChunkRange: { first: 1, last: 2 },
    verifiedHeaderCount: 4,
  })
  expect(result.report.symbols[0]).toMatchObject({
    observedQuoteCount: 0,
    maximumQuoteArrivalGapIncludingBoundariesMs: 8,
  })
})

test('unsealed or incomplete captures remain explicit, never upgraded by complete local byte verification', () => {
  const input = fixture()
  expect(Result.getOrThrow(auditNativeArrivalCoverage({ ...input, end: null })).report.endReceipt).toBeNull()
  const end = { ...input.end, status: 'INCOMPLETE', observedConsumerSequence: 7, reason: 'retained capture failure' }
  expect(Result.getOrThrow(auditNativeArrivalCoverage({ ...input, end })).report).toMatchObject({
    qualification: 'UNQUALIFIED',
    endReceipt: end,
  })
})

test.each([
  'epoch',
  'header',
  'bytes',
  'end',
  'sequence',
  'chunk order',
  'missing chunk',
  'missing header',
  'interval',
  'symbol',
])('fails closed for %s corruption or coverage gaps', (kind) => {
  const input = fixture()
  const broken: unknown =
    kind === 'epoch'
      ? { ...input, epoch: { ...input.epoch, contentHash: '0'.repeat(64) } }
      : kind === 'header'
        ? {
            ...input,
            headers: input.headers.map((row, index) => (index === 1 ? { ...row, contentHash: '0'.repeat(64) } : row)),
          }
        : kind === 'bytes'
          ? {
              ...input,
              chunks: input.chunks.map((row, index) =>
                index === 1 ? { ...row, compressedBase64: Buffer.from('bad gzip').toString('base64') } : row,
              ),
            }
          : kind === 'end'
            ? { ...input, end: { ...input.end, durableConsumerSequence: 2 } }
            : kind === 'sequence'
              ? {
                  ...input,
                  headers: input.headers.map((row, index) =>
                    index === 1 ? { ...row, header: { ...row.header, firstConsumerSequence: 3 } } : row,
                  ),
                }
              : kind === 'chunk order'
                ? { ...input, chunks: [...input.chunks].reverse() }
                : kind === 'missing chunk'
                  ? { ...input, chunks: input.chunks.filter((_, index) => index !== 1) }
                  : kind === 'missing header'
                    ? { ...input, headers: input.headers.filter((_, index) => index !== 1) }
                    : kind === 'interval'
                      ? { ...input, interval: { startMs: 999, endMs: 1025 } }
                      : { ...input, symbols: ['AAPL'] }
  expect(Result.isFailure(auditNativeArrivalCoverage(broken))).toBe(true)
})

test.each(['foreign epoch', 'invalidated', 'rejected', 'tombstone', 'unknown topic'])(
  'rejects a resealed %s delivery instead of accepting its valid gzip/hash',
  (kind) => {
    const changed = records.map((record, index): NativeArrival => {
      if (index !== 1) return record
      if (kind === 'foreign epoch') return { ...record, receipt: { ...record.receipt, consumerEpoch: 'foreign' } }
      if (kind === 'invalidated') return { ...record, receipt: { ...record.receipt, reason: 'assignment-invalidated' } }
      if (kind === 'rejected')
        return { ...record, receipt: { ...record.receipt, disposition: CaptureDisposition.Rejected } }
      if (kind === 'unknown topic') return { ...record, record: { ...record.record, topic: 'not-captured' } }
      return {
        ...record,
        record: { ...record.record, value: '' },
        rawValueBase64: null,
        receipt: { ...record.receipt, tombstone: true, rawValueSha256: null, rawByteLength: null },
      }
    })
    expect(Result.isFailure(auditNativeArrivalCoverage(fixture(changed)))).toBe(true)
  },
)

test('ignored deliveries preserve global continuity without becoming observed pricing', () => {
  const input = fixture(
    records.map((record, index) =>
      index === 1 ? { ...record, receipt: { ...record.receipt, disposition: CaptureDisposition.Ignored } } : record,
    ),
  )
  const result = Result.getOrThrow(auditNativeArrivalCoverage(input))
  expect(result.report).toMatchObject({ verifiedRecords: 4, ignoredRecords: 1 })
  expect(result.quotes.map((quote) => quote.sequence)).toEqual([1, 3, 4])
})

test.each([NaN, Infinity, -Infinity, 900.5, 10_000])(
  'rejects resealed accepted deliveries with invalid or mismatched original producer clock %s',
  (timestampMs) => {
    const changed = records.map((record, index) =>
      index === 1 ? { ...record, originalTransport: captureKafkaTransport(timestampMs) } : record,
    )
    const result = auditNativeArrivalCoverage(fixture(changed))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure.cause)).toContain('producer clock contract')
  },
)

test.each([undefined, 910])('preserves the shared decoder treatment of original timestamp %s', (timestampMs) => {
  const changed = records.map((record, index) =>
    index === 1 ? { ...record, originalTransport: captureKafkaTransport(timestampMs) } : record,
  )
  expect(Result.getOrThrow(auditNativeArrivalCoverage(fixture(changed))).quotes).toHaveLength(4)
})

test('rejects a resealed accepted delivery that the native decoder ignores', () => {
  const changed = records.map((record, index) => {
    if (index !== 1) return record
    const at = new Date(910).toISOString()
    const value = JSON.stringify({
      provider: 'alpaca',
      feed: 'us',
      delayClass: 'real_time_crypto',
      marketSession: 'continuous',
      channel: 'orderbooks',
      seq: 2,
      symbol: 'BTC/USD',
      version: 2,
      eventTs: at,
      ingestTs: at,
      payload: { T: 'o', S: 'BTC/USD', t: at },
    })
    return nativeArrival(epoch, { ...nativeArrivalObservationFixture(2, value), availableAtMs: record.availableAtMs })
  })
  const result = auditNativeArrivalCoverage(fixture(changed))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(String(result.failure.cause)).toContain('decoder disposition')
})

test('a configured symbol without quotes stays empty, not synthetic or zero-priced', () => {
  const result = Result.getOrThrow(auditNativeArrivalCoverage({ ...fixture(), symbols: ['ETH/USD'] }))
  expect(result.quotes).toEqual([])
  expect(result.report.symbols[0]).toMatchObject({
    observedQuoteCount: 0,
    initialQuoteAvailableAtMs: null,
    firstQuoteAvailableAtMs: null,
    lastQuoteAvailableAtMs: null,
    maximumQuoteArrivalGapIncludingBoundariesMs: 20,
  })
})
