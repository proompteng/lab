import { expect, test } from 'bun:test'

import { describeEntryAllocation, EntryAllocationReason } from './entry-allocation-observation'

const facts = {
  noTrade: true,
  positiveTarget: true,
  flat: true,
  allocationCapitalMicros: '0',
  priorRecordedTurnoverMicros: '1100000000',
  maximumTurnoverMicros: '1000000000',
}

test('explains exhausted turnover without rewriting the retained target-plan reason', () => {
  expect(describeEntryAllocation(facts)).toBe(EntryAllocationReason.TurnoverBudgetExhausted)
  expect(describeEntryAllocation({ ...facts, priorRecordedTurnoverMicros: facts.maximumTurnoverMicros })).toBe(
    EntryAllocationReason.TurnoverBudgetExhausted,
  )
})

test('does not infer turnover exhaustion from zero capital alone or missing history', () => {
  for (const priorRecordedTurnoverMicros of [null, '0', '999999999'])
    expect(describeEntryAllocation({ ...facts, priorRecordedTurnoverMicros })).toBe(
      EntryAllocationReason.ZeroAllocation,
    )
  expect(describeEntryAllocation({ ...facts, maximumTurnoverMicros: null })).toBe(EntryAllocationReason.ZeroAllocation)
})

test('does not relabel a held target, a zero signal, a funded plan, or unavailable evidence', () => {
  expect(describeEntryAllocation(null)).toBeNull()
  expect(describeEntryAllocation(undefined)).toBeNull()
  expect(describeEntryAllocation({ ...facts, noTrade: false })).toBeNull()
  expect(describeEntryAllocation({ ...facts, positiveTarget: false })).toBeNull()
  expect(describeEntryAllocation({ ...facts, flat: false })).toBeNull()
  expect(describeEntryAllocation({ ...facts, allocationCapitalMicros: '1' })).toBeNull()
  expect(describeEntryAllocation({ ...facts, allocationCapitalMicros: null })).toBeNull()
})
