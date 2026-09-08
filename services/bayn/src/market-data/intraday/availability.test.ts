import { describe, expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect'

import { operationalError } from '../../errors'
import { canonicalHashV1 } from '../../hash'
import {
  availabilityReader,
  availabilityRequest,
  availabilitySnapshot,
  reobserveAvailabilitySnapshot,
} from '../../testing/archive-availability-fixture'
import {
  makeArchiveAvailabilityReceipts,
  verifyArchiveAvailabilityReceipt,
  verifyRecordedArchiveAvailability,
  withRecordedArchiveReads,
  type ArchiveAvailabilityReceipt,
} from './availability'
import type { IntradayMarketDataService } from './model'

const completedAt = '2026-09-04T14:30:02.500Z'
const receipts = () =>
  Result.getOrThrow(
    makeArchiveAvailabilityReceipts(
      availabilitySnapshot,
      availabilityReader,
      availabilityRequest.observedAt,
      completedAt,
    ),
  )
const market = (read = Effect.succeed(availabilitySnapshot)): IntradayMarketDataService => ({
  check: Effect.void,
  captureVersion: () => Effect.succeed(availabilityRequest.archiveWatermarks),
  loadSnapshot: () => read,
  verifyArchiveSnapshot: () => read,
})

describe('recorded archive reader availability', () => {
  test('a source-received row is unavailable until its completed reader observation', () => {
    const evidence = receipts()
    const earlier = verifyRecordedArchiveAvailability(availabilitySnapshot, availabilityReader.endpointHash, evidence)
    expect(Result.isFailure(earlier)).toBe(true)
    const atBoundary = reobserveAvailabilitySnapshot(completedAt)
    const proven = Result.getOrThrow(
      verifyRecordedArchiveAvailability(atBoundary, availabilityReader.endpointHash, evidence),
    )
    expect(proven.receipts).toEqual(evidence)
    expect(proven.observedAt).toBe(completedAt)
  })

  test('missing and duplicate records cannot establish availability', () => {
    const snapshot = reobserveAvailabilitySnapshot(completedAt)
    expect(Result.isFailure(verifyRecordedArchiveAvailability(snapshot, availabilityReader.endpointHash, []))).toBe(
      true,
    )
    const evidence = receipts()
    expect(
      Result.isFailure(
        verifyRecordedArchiveAvailability(snapshot, availabilityReader.endpointHash, [...evidence, ...evidence]),
      ),
    ).toBe(true)
  })

  test('backfill reads cannot backdate availability and clock regression is rejected', () => {
    const late = Result.getOrThrow(
      makeArchiveAvailabilityReceipts(
        availabilitySnapshot,
        availabilityReader,
        '2026-09-07T14:00:00.000Z',
        '2026-09-07T14:00:01.000Z',
      ),
    )
    expect(
      Result.isFailure(verifyRecordedArchiveAvailability(availabilitySnapshot, availabilityReader.endpointHash, late)),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeArchiveAvailabilityReceipts(
          availabilitySnapshot,
          availabilityReader,
          completedAt,
          availabilityRequest.observedAt,
        ),
      ),
    ).toBe(true)
  })

  test('rehashed development receipts and a different reader do not establish production visibility', () => {
    const development = Result.getOrThrow(
      makeArchiveAvailabilityReceipts(
        availabilitySnapshot,
        { ...availabilityReader, verification: 'development-configured' },
        availabilityRequest.observedAt,
        completedAt,
      ),
    )
    const snapshot = reobserveAvailabilitySnapshot(completedAt)
    expect(
      Result.isFailure(verifyRecordedArchiveAvailability(snapshot, availabilityReader.endpointHash, development)),
    ).toBe(true)
    expect(Result.isFailure(verifyRecordedArchiveAvailability(snapshot, 'f'.repeat(64), receipts()))).toBe(true)
  })

  test('altered raw evidence and receipt hashes are rejected', () => {
    const [receipt] = receipts()
    if (receipt === undefined) throw new Error('fixture has no receipt')
    expect(Result.isFailure(verifyArchiveAvailabilityReceipt({ ...receipt, receiptHash: 'f'.repeat(64) }))).toBe(true)
    const { receiptHash: _hash, ...material } = receipt
    const changed = { ...material, record: { changed: true } }
    expect(
      Result.isFailure(verifyArchiveAvailabilityReceipt({ ...changed, receiptHash: canonicalHashV1(changed) })),
    ).toBe(true)
  })

  test('records only after the read completes and rounds the availability upper bound up', async () => {
    const events: string[] = []
    const retained: ArchiveAvailabilityReceipt[] = []
    let current = availabilityRequest.observedAt
    const observed = withRecordedArchiveReads(
      market(
        Effect.sync(() => {
          events.push('read')
          current = completedAt
          return availabilitySnapshot
        }),
      ),
      availabilityReader,
      (batch) =>
        Effect.sync(() => {
          events.push('record')
          retained.push(...batch)
        }),
      Effect.sync(() => current),
    )
    const returned = await Effect.runPromise(observed.loadSnapshot(availabilityRequest))
    expect(returned).toBe(availabilitySnapshot)
    expect(events).toEqual(['read', 'record'])
    expect(retained[0]?.availableAt).toBe('2026-09-04T14:30:02.501Z')
    expect(
      Result.isFailure(verifyRecordedArchiveAvailability(returned, availabilityReader.endpointHash, retained)),
    ).toBe(true)
  })

  test('recording failure cannot release a snapshot to the execution caller', async () => {
    const error = operationalError({
      component: 'database',
      operation: 'archive-availability',
      message: 'receipt store unavailable',
    })
    const observed = withRecordedArchiveReads(
      market(),
      availabilityReader,
      () => Effect.fail(error),
      Effect.succeed(completedAt),
    )
    const result = await Effect.runPromiseExit(observed.loadSnapshot(availabilityRequest))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(false)
  })

  test('interruption during a read cannot fabricate a completed receipt', async () => {
    let count = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const read = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          const observed = withRecordedArchiveReads(
            market(read),
            availabilityReader,
            () =>
              Effect.sync(() => {
                count += 1
              }),
            Effect.succeed(completedAt),
          )
          const fiber = yield* observed.loadSnapshot(availabilityRequest).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
    expect(count).toBe(0)
  })

  test('a one-millisecond clock regression cannot be hidden by rounding', async () => {
    let current = completedAt
    let count = 0
    const observed = withRecordedArchiveReads(
      market(
        Effect.sync(() => {
          current = '2026-09-04T14:30:02.499Z'
          return availabilitySnapshot
        }),
      ),
      availabilityReader,
      () =>
        Effect.sync(() => {
          count += 1
        }),
      Effect.sync(() => current),
    )
    expect(Exit.isFailure(await Effect.runPromiseExit(observed.loadSnapshot(availabilityRequest)))).toBe(true)
    expect(count).toBe(0)
  })

  test('a self-rehashed receipt cannot change the raw Kafka identity', () => {
    const [receipt] = receipts()
    if (receipt === undefined) throw new Error('fixture has no receipt')
    const { receiptHash: _hash, ...material } = receipt
    const changed = { ...material, recordId: 'f'.repeat(64) }
    expect(
      Result.isFailure(verifyArchiveAvailabilityReceipt({ ...changed, receiptHash: canonicalHashV1(changed) })),
    ).toBe(true)
  })
})
