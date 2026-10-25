import assert from 'node:assert/strict'

import { test } from 'bun:test'
import { Result } from 'effect'

import { makeForwardPerformanceExecutionMeasurements } from './execution-quality'
import { executionQualityFixture } from './execution-quality.test-support'
import { makeForwardPerformanceReport } from './report'

const measure = (input: ReturnType<typeof executionQualityFixture>) =>
  Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(input))

test('preserves the synthetic complete report and evidence hashes across input order', () => {
  const input = executionQualityFixture(10)
  const report = Result.getOrThrow(makeForwardPerformanceReport(input, []))
  assert.equal(report.reportHash, '1f37fd5387df1ac1fee4bc88241d12ecef09c68019668ed434be22d418f119c1')
  assert.equal(report.receipt.executionQuality.status, 'MEASURED')
  assert.deepEqual(
    Result.getOrThrow(
      makeForwardPerformanceReport(
        {
          ...input,
          cycles: input.cycles.toReversed(),
          executionEvidence: input.executionEvidence?.toReversed(),
          transactions: input.transactions.toReversed(),
        },
        [],
      ),
    ),
    report,
  )
})

test('a duplicate cycle identity matches if any occurrence is completed, in either order', () => {
  const input = executionQualityFixture(1)
  const cycle = input.cycles[0]
  assert(cycle !== undefined)
  const noTrade = { ...cycle, state: 'NO_TRADE' as const }
  const expected = measure(input)
  for (const cycles of [
    [cycle, noTrade],
    [noTrade, cycle],
    [cycle, cycle],
  ])
    assert.deepEqual(measure({ ...input, cycles }), expected)
})

test('missing, non-completed and non-exact cycle identities remain fail-closed', () => {
  const input = executionQualityFixture(1)
  const cycle = input.cycles[0]
  assert(cycle !== undefined)
  for (const cycles of [[], [{ ...cycle, state: 'NO_TRADE' as const }], [{ ...cycle, cycleId: `${cycle.cycleId}0` }]]) {
    const result = measure({ ...input, cycles })
    assert.equal(result.executionQuality.status, 'UNDETERMINED')
    assert.deepEqual(result.executionQuality.reasonCodes, ['FILL_IDENTITY_DRIFT'])
  }
})

test('completed identities are read once per cycle rather than once per execution', () => {
  const input = executionQualityFixture(100)
  let reads = 0
  const cycles = input.cycles.map((cycle) => ({
    ...cycle,
    get cycleId() {
      reads += 1
      return cycle.cycleId
    },
  }))
  assert.equal(measure({ ...input, cycles }).executionQuality.status, 'MEASURED')
  assert.equal(reads, cycles.length)
})

test('a later call observes changed cycle state instead of retaining a prior completion proof', () => {
  const input = executionQualityFixture(1)
  const cycle = input.cycles[0]
  assert(cycle !== undefined)
  const mutableCycle = { ...cycle }
  const current = { ...input, cycles: [mutableCycle] }
  assert.equal(measure(current).executionQuality.status, 'MEASURED')
  mutableCycle.state = 'NO_TRADE'
  assert.deepEqual(measure(current).executionQuality.reasonCodes, ['FILL_IDENTITY_DRIFT'])
})

test('execution evidence hash failures retain their exact error before reading cycle identities', () => {
  const input = executionQualityFixture(1)
  const result = makeForwardPerformanceReport(
    {
      ...input,
      account: { ...input.account, accountId: '\ud800' },
      get cycles() {
        throw new Error('cycle identities must not be read after failed source hashing')
      },
    },
    [],
  )
  assert(Result.isFailure(result))
  assert.deepEqual(result.failure, {
    _tag: 'ForwardPerformanceDomainFailure',
    operation: 'hash-execution-evidence',
    cause: {
      _tag: 'CanonicalJsonFailure',
      path: '$.account.accountId',
      reason: 'invalid-unicode-surrogate',
      actualType: 'string',
    },
  })
})
