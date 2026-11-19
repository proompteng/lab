import assert from 'node:assert/strict'

import { test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../hash'

import { makeForwardPerformanceExecutionMeasurements } from './execution-quality'
import { executionQualityFixture, partialExecutionQualityFixture } from './execution-quality.test-support'
import { makeForwardPerformanceReport } from './report'

const measure = (input: ReturnType<typeof executionQualityFixture>) =>
  Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(input))

test('preserves the synthetic complete report and evidence hashes across input order', () => {
  const input = executionQualityFixture(10)
  const report = Result.getOrThrow(makeForwardPerformanceReport(input, []))
  assert.equal(report.reportHash, '74f285a84e370480106d65ffa2ebe18d508b66206e9e78855c3d497057d44cd9')
  assert.equal(report.receipt.receiptHash, 'f4d8eead77745a0354ca0efdb6d6d3b737ac0013a1a1a83761f00a07300d0f26')
  assert.equal(
    Result.getOrThrow(canonicalHashV1Result(report.receipt)),
    'e0c14bb31545ab1b216e7cc0b14aa58ab06ba706f4e59fc3c45fc56536e17a9a',
  )
  assert.equal(report.receipt.executionQuality.status, 'MEASURED')
  assert.deepEqual(
    Result.getOrThrow(
      makeForwardPerformanceReport(
        {
          ...input,
          cycles: input.cycles.toReversed(),
          executionEvidence: input.executionEvidence.toReversed(),
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
      get cycles(): typeof input.cycles {
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

test('partial executions retain exact opportunity costs and report hashes across volume order', () => {
  const input = partialExecutionQualityFixture(10)
  const original = structuredClone(input)
  const expected = measure(input)
  assert.equal(expected.executionQuality.status, 'MEASURED')
  assert.equal(expected.observedCapacity.status, 'MEASURED')
  assert.equal(expected.executionQuality.implementationShortfall?.opportunityShortfallMicros, '-30000000')
  assert.deepEqual(
    measure({
      ...input,
      executionEvidence: input.executionEvidence.toReversed(),
      marketVolumeEvidence: input.marketVolumeEvidence.toReversed(),
    }),
    expected,
  )
  assert.deepEqual(input, original)
})

test('partial executions reject missing, duplicate and mismatched market-volume identities', () => {
  const input = partialExecutionQualityFixture(2)
  const volume = input.marketVolumeEvidence[0]
  assert(volume !== undefined)
  for (const marketVolumeEvidence of [
    input.marketVolumeEvidence.slice(1),
    [...input.marketVolumeEvidence, volume],
    [volume, ...input.marketVolumeEvidence, volume],
    [{ ...volume, symbol: 'AAPL' }, ...input.marketVolumeEvidence.slice(1)],
  ]) {
    const measured = measure({ ...input, marketVolumeEvidence })
    assert.equal(measured.executionQuality.status, 'UNDETERMINED')
    assert.deepEqual(measured.executionQuality.reasonCodes, ['TERMINAL_PRICE_EVIDENCE_GAP'])
  }
})

test('partial execution volume matching is rebuilt for each measurement', () => {
  const input = partialExecutionQualityFixture(1)
  const volume = input.marketVolumeEvidence[0]
  assert(volume !== undefined)
  const volumes = [...input.marketVolumeEvidence]
  const current = { ...input, marketVolumeEvidence: volumes }
  assert.equal(measure(current).executionQuality.status, 'MEASURED')
  volumes.push(volume)
  assert.deepEqual(measure(current).executionQuality.reasonCodes, ['TERMINAL_PRICE_EVIDENCE_GAP'])
  volumes.pop()
  assert.equal(measure(current).executionQuality.status, 'MEASURED')
})
