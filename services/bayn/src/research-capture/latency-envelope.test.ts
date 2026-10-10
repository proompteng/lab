import { expect, test } from 'bun:test'

import { CaptureInvalidation, CaptureQualification } from './capture'
import { runCaptureLatencyEnvelope } from './latency-envelope.test-support'

const bounded = (result: Awaited<ReturnType<typeof runCaptureLatencyEnvelope>>) => {
  expect(result.evidenceKind).toBe('SYNTHETIC_CONSTANT_LATENCY')
  expect(result.maximumRetainedReceipts).toBeLessThanOrEqual(1024)
  expect(result.maximumRetainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(result.attemptedObjectBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(result.attemptedSqlBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(result.retainedAfterFinish).toBe(0)
  expect(result.observedReceipts).toBe(result.marketReceipts + 1)
  expect(result.qualification).toBe(CaptureQualification.Unqualified)
}

test.each([
  [0, 0],
  [5, 0],
  [0, 5],
  [3, 2],
])('the synthetic 50ms burst fits with object=%ims and SQL=%ims', async (object, sql) => {
  const result = await runCaptureLatencyEnvelope(object, sql)
  bounded(result)
  expect(result.invalidations).toEqual([])
  expect(result.persistedReceipts).toBe(result.observedReceipts)
  expect(result.firstInvalidationAtMs).toBeNull()
})

test.each([
  [6, 0],
  [0, 6],
  [3, 3],
])('the same synthetic burst overflows before the deadline with object=%ims and SQL=%ims', async (object, sql) => {
  const result = await runCaptureLatencyEnvelope(object, sql)
  bounded(result)
  expect(result.invalidations).toEqual([CaptureInvalidation.Overflow])
  expect(result.firstInvalidationAtMs).toBe(19)
  expect(result.maximumRetainedReceipts).toBe(1024)
  expect(result.persistedReceipts).toBeLessThan(result.observedReceipts)
})

// A uniform comparison, not a measured native arrival schedule or a bound on real bursts.
const uniform = { receipts: 5500, durationMs: 5000 }

test.each([
  [450, 0],
  [0, 450],
  [200, 200],
])('a uniform 1100/s comparison fits with object=%ims and SQL=%ims', async (object, sql) => {
  const result = await runCaptureLatencyEnvelope(object, sql, uniform)
  bounded(result)
  expect(result.invalidations).toEqual([])
  expect(result.persistedReceipts).toBe(5501)
})

test.each([
  [500, 0],
  [0, 500],
  [250, 250],
])('a uniform 1100/s comparison overflows with object=%ims and SQL=%ims', async (object, sql) => {
  const result = await runCaptureLatencyEnvelope(object, sql, uniform)
  bounded(result)
  expect(result.invalidations).toEqual([CaptureInvalidation.Overflow])
  expect(result.firstInvalidationAtMs).toBe(980)
  expect(result.maximumRetainedReceipts).toBe(1024)
  expect(result.persistedReceipts).toBeLessThan(result.observedReceipts)
})

test('separate sub-second object and SQL phases still share the aggregate write deadline', async () => {
  const result = await runCaptureLatencyEnvelope(600, 600)
  bounded(result)
  expect(result.invalidations).toEqual([CaptureInvalidation.Persistence])
  expect(result.persistedReceipts).toBe(0)
  expect(result.sqlAppends).toBe(0)
  expect(result.sqlSeals).toBe(0)
})
