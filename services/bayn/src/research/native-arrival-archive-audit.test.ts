import { expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import { nativeArrivalObservationFixture as observation } from '../market-data/streaming/native-arrival.test-support'
import { CaptureDisposition } from '../market-data/streaming/transport-evidence'
import { auditNativeArrivalArchive } from './native-arrival-archive-audit'
import { exportNativeArrivalPrefix } from './native-arrival-export'
import { nativeArrivalArchiveFixture } from './native-arrival-export.test-support'

const bytes = (value: unknown) => new TextEncoder().encode(Result.getOrThrow(canonicalJsonV1Result(value)))
const exportedFixture = async () => {
  const f = nativeArrivalArchiveFixture()
  await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 1))
  const receipt = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 20))
  return { ...f, receipt }
}
const request = (receipt: { captureId: string; receiptHash: string }, maximumPages = 3) => ({
  captureId: receipt.captureId,
  receiptHash: receipt.receiptHash,
  maximumPages,
  auditSourceRevision: 'f'.repeat(40),
})

test('audits the entire original archive across exports and after a zero-page resume', async () => {
  const f = await exportedFixture()
  expect(f.receipt.pagesWritten).toBe(2)
  const report = await Effect.runPromise(auditNativeArrivalArchive(f.archive, request(f.receipt)))
  expect(report.pages).toBe(3)
  expect(report.chunks).toBe(20)
  expect(report.records).toBe(20)
  expect(report.deliveries[0]?.dispositions).toEqual({ ACCEPTED: 20, IGNORED: 0, REJECTED: 0 })
  expect(report.completeRetainedPrefixBytesVerified).toBeTrue()
  expect(report.completeSessionCoverage).toBeFalse()
  expect(report.controllerCoverage).toBe('UNKNOWN')
  expect(report.end?.consumerScopeCompleted).toBeFalse()
  expect(report.qualification).toBe('UNQUALIFIED')
  const repeat = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 20))
  expect(repeat.pagesWritten).toBe(0)
  expect((await Effect.runPromise(auditNativeArrivalArchive(f.archive, request(repeat)))).records).toBe(20)
})

test('counts rejected, ignored, invalidated and tombstone deliveries without filtering the denominator', async () => {
  const f = nativeArrivalArchiveFixture(4, (sequence) => {
    const original = observation(sequence)
    if (sequence === 4)
      return {
        ...original,
        record: {
          ...original.record,
          tombstone: true,
          rawValue: null,
          rawValueSha256: null,
          rawByteLength: null,
          value: '',
        },
        disposition: CaptureDisposition.Rejected,
      }
    return {
      ...original,
      disposition:
        sequence === 1
          ? CaptureDisposition.Accepted
          : sequence === 2
            ? CaptureDisposition.Ignored
            : CaptureDisposition.Rejected,
      assignmentInvalidated: sequence === 3,
    }
  })
  const receipt = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 20))
  const report = await Effect.runPromise(auditNativeArrivalArchive(f.archive, request(receipt)))
  expect(report.records).toBe(4)
  expect(report.deliveries[0]).toMatchObject({
    records: 4,
    dispositions: { ACCEPTED: 1, IGNORED: 1, REJECTED: 2 },
    tombstones: 1,
    assignmentInvalidated: 1,
  })
})

test('an empty retained prefix and a bounded partial export retain their actual limits', async () => {
  const empty = nativeArrivalArchiveFixture(0)
  const emptyReceipt = await Effect.runPromise(exportNativeArrivalPrefix(empty.source, empty.archive, 1))
  const emptyReport = await Effect.runPromise(auditNativeArrivalArchive(empty.archive, request(emptyReceipt)))
  expect(emptyReport.records).toBe(0)
  expect(emptyReport.deliveries[0]?.records).toBe(0)
  expect(emptyReport.firstAvailableAtMs).toBeNull()
  expect(emptyReport.completeSessionCoverage).toBeFalse()
  const partial = nativeArrivalArchiveFixture()
  const receipt = await Effect.runPromise(exportNativeArrivalPrefix(partial.source, partial.archive, 1))
  const report = await Effect.runPromise(auditNativeArrivalArchive(partial.archive, request(receipt)))
  expect(report.records).toBe(8)
  expect(report.end?.durableConsumerSequence).toBe(20)
  expect(report.completeSessionCoverage).toBeFalse()
})

test('the explicit page budget fails instead of publishing a truncated success', async () => {
  const f = await exportedFixture()
  const keys: string[] = []
  const reader = {
    read: (key: string, maximum: number) => {
      keys.push(key)
      return f.archive.read(key, maximum)
    },
  }
  expect(
    Exit.isFailure(await Effect.runPromiseExit(auditNativeArrivalArchive(reader, request(f.receipt, 1)))),
  ).toBeTrue()
  expect(keys.filter((key) => key.includes('/pages/'))).toHaveLength(1)
})

test.each(['missing-old-page', 'changed-old-page', 'changed-receipt', 'missing-end'])(
  'refuses missing or changed retained bytes: %s',
  async (scenario) => {
    const f = await exportedFixture()
    const first = f.pageKeys()[0]
    if (first === undefined || f.receipt.end === null) throw new Error('Missing test objects')
    if (scenario === 'missing-old-page') f.objects.delete(first)
    if (scenario === 'changed-old-page') f.objects.set(first, { body: bytes({ changed: true }), etag: 'changed' })
    if (scenario === 'changed-receipt') {
      const key = `native-evidence/v1/arrivals/${f.receipt.captureId}/receipts/${f.receipt.receiptHash}.json`
      f.objects.set(key, { body: bytes({ ...f.receipt, nextOrdinal: 21 }), etag: 'changed' })
    }
    if (scenario === 'missing-end') f.objects.delete(f.receipt.end.key)
    expect(
      Exit.isFailure(await Effect.runPromiseExit(auditNativeArrivalArchive(f.archive, request(f.receipt)))),
    ).toBeTrue()
  },
)

test.each(['skipped-prefix', 'outside-key', 'corrupt-compression', 'run-boundary', 'end-conflict'])(
  'a newly hashed root cannot hide invalid source structure: %s',
  async (scenario) => {
    const f = await exportedFixture()
    const { receiptHash: _oldHash, ...material } = f.receipt
    let changed = { ...material }
    if (scenario === 'run-boundary') changed = { ...changed, firstOrdinal: 9 }
    else if (scenario === 'end-conflict') {
      const end = {
        captureId: f.receipt.captureId,
        status: 'STOPPED',
        observedConsumerSequence: 19,
        durableConsumerSequence: 19,
        lastChunkHash: 'a'.repeat(64),
        reason: null,
        consumerScopeCompleted: false,
      }
      const body = bytes(end)
      changed = {
        ...changed,
        end: await Effect.runPromise(
          f.archive.retain(`native-evidence/v1/arrivals/${f.receipt.captureId}/ends/${sha256(body)}.json`, body),
        ),
      }
    } else {
      if (f.receipt.lastPage === null) throw new Error('Missing test page')
      const stored = f.objects.get(f.receipt.lastPage.key)
      if (stored === undefined) throw new Error('Missing test page bytes')
      const page = JSON.parse(new TextDecoder().decode(stored.body))
      if (scenario === 'skipped-prefix') page.previousPage = null
      if (scenario === 'outside-key') page.previousPage.key = 'other-capture/pages/changed.json'
      if (scenario === 'corrupt-compression')
        page.chunks[0].compressedBase64 = Buffer.from('changed raw bytes').toString('base64')
      const body = bytes(page)
      changed = {
        ...changed,
        lastPage: await Effect.runPromise(
          f.archive.retain(`native-evidence/v1/arrivals/${f.receipt.captureId}/pages/${sha256(body)}.json`, body),
        ),
      }
    }
    const receiptHash = Result.getOrThrow(canonicalHashV1Result(changed))
    await Effect.runPromise(
      f.archive.retain(
        `native-evidence/v1/arrivals/${f.receipt.captureId}/receipts/${receiptHash}.json`,
        bytes({ ...changed, receiptHash }),
      ),
    )
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          auditNativeArrivalArchive(f.archive, request({ captureId: f.receipt.captureId, receiptHash })),
        ),
      ),
    ).toBeTrue()
  },
)
