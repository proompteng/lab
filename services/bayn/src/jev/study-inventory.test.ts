import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { CycleState } from '../cycle/model'
import { canonicalHashV1Result } from '../hash'
import { JevPurpose } from './portfolio'
import { verifyJevStudyInventory, type JevStudyInventory } from './study-inventory'

const fixture = (): JevStudyInventory => {
  const cycles = [
    {
      cycleId: 'a'.repeat(64),
      protocolHash: 'b'.repeat(64),
      state: CycleState.Completed,
      decisionHash: 'c'.repeat(64),
    },
    { cycleId: 'd'.repeat(64), protocolHash: 'b'.repeat(64), state: CycleState.Blocked, decisionHash: null },
  ]
  const batches = [
    {
      batchId: 'e'.repeat(64),
      cycleId: cycles[0].cycleId,
      observationHash: 'f'.repeat(64),
      purpose: JevPurpose.Entry,
      resultHash: null,
    },
    {
      batchId: 'f'.repeat(64),
      cycleId: cycles[0].cycleId,
      observationHash: 'e'.repeat(64),
      purpose: JevPurpose.Manage,
      resultHash: 'a'.repeat(64),
    },
  ]
  const receipt: Omit<JevStudyInventory['receipt'], 'receiptHash'> = {
    schemaVersion: 'bayn.jev-study-export.v1',
    accountBindingHash: 'b'.repeat(64),
    sessionDate: '2026-09-04',
    asOf: '2026-09-05T00:00:00.000Z',
    cycleCount: 2,
    batchCount: 2,
    entryBatchCount: 1,
    managementBatchCount: 1,
    pendingResultCount: 1,
    sourceCoverage: 'RECORDED_OBSERVATIONS_ONLY',
    qualification: 'UNQUALIFIED',
    controllerCoverage: 'UNKNOWN',
    bytes: 1000,
    dataSha256: 'c'.repeat(64),
  }
  return {
    schemaVersion: 'bayn.jev-study-inventory.v1',
    receipt: { ...receipt, receiptHash: Result.getOrThrow(canonicalHashV1Result(receipt)) },
    cycles,
    batches,
  }
}

test('native inventory retains completed and no-batch cycles, management and pending entry results', () => {
  const inventory = fixture()
  expect(Result.getOrThrow(verifyJevStudyInventory(inventory))).toEqual(inventory)
  const { receiptHash: _hash, ...receipt } = inventory.receipt
  const empty = {
    ...receipt,
    cycleCount: 0,
    batchCount: 0,
    entryBatchCount: 0,
    managementBatchCount: 0,
    pendingResultCount: 0,
  }
  expect(
    Result.isSuccess(
      verifyJevStudyInventory({
        ...inventory,
        cycles: [],
        batches: [],
        receipt: { ...empty, receiptHash: Result.getOrThrow(canonicalHashV1Result(empty)) },
      }),
    ),
  ).toBeTrue()
})

test('native inventory rejects malformed, unsupported and inconsistent cuts', () => {
  const inventory = fixture()
  for (const changed of [
    {},
    { arbitrary: 'a valid hash cannot make these bytes an inventory' },
    { ...inventory, schemaVersion: 'bayn.jev-study-inventory.v0' },
    { ...inventory, receipt: { ...inventory.receipt, dataSha256: 'd'.repeat(64) } },
    { ...inventory, cycles: [...inventory.cycles].reverse() },
    { ...inventory, cycles: [inventory.cycles[0], inventory.cycles[0]] },
    { ...inventory, cycles: inventory.cycles.slice(1) },
    { ...inventory, batches: [...inventory.batches].reverse() },
    { ...inventory, batches: [inventory.batches[0], inventory.batches[0]] },
    { ...inventory, batches: inventory.batches.slice(1) },
    { ...inventory, batches: inventory.batches.map((batch) => ({ ...batch, cycleId: '0'.repeat(64) })) },
    { ...inventory, batches: inventory.batches.map((batch) => ({ ...batch, purpose: JevPurpose.Entry })) },
    { ...inventory, batches: inventory.batches.map((batch) => ({ ...batch, resultHash: null })) },
  ])
    expect(Result.isFailure(verifyJevStudyInventory(changed))).toBeTrue()
})
