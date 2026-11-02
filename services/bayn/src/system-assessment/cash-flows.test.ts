import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import {
  CashAdjustmentKind,
  CashFlowEvidenceSchema,
  cashFlowsSupported,
  cashFlowTotals,
  cashFlowsMatchSession,
} from './cash-flows'
import { testHash } from './fixtures.test-support'

const fixture = () =>
  Schema.decodeUnknownSync(CashFlowEvidenceSchema)({
    schemaVersion: 'bayn.system-cash-flow-evidence.v1',
    accountBindingHash: testHash('account'),
    sessionDate: '2026-11-02',
    asOf: '2026-11-02T21:00:00.000Z',
    coverage: 'COMPLETE',
    movements: [
      {
        movementId: testHash('deposit'),
        sourceHash: testHash('deposit receipt'),
        kind: CashAdjustmentKind.External,
        at: '2026-11-02T15:00:00.000Z',
        amountMicros: '1000000',
      },
      {
        movementId: testHash('withdrawal'),
        sourceHash: testHash('withdrawal receipt'),
        kind: CashAdjustmentKind.External,
        at: '2026-11-02T16:00:00.000Z',
        amountMicros: '-100000',
      },
      {
        movementId: testHash('yield'),
        sourceHash: testHash('yield receipt'),
        kind: CashAdjustmentKind.PassiveYield,
        at: '2026-11-02T17:00:00.000Z',
        amountMicros: '5000',
      },
      {
        movementId: testHash('invoice'),
        sourceHash: testHash('invoice receipt'),
        kind: CashAdjustmentKind.PaidOperatingCost,
        at: '2026-11-02T18:00:00.000Z',
        amountMicros: '20000',
      },
    ],
  })
const verified = (evidence: typeof CashFlowEvidenceSchema.Type) =>
  new Set([testHash(evidence), ...evidence.movements.map((m) => m.sourceHash)])

describe('cash-flow provenance and attribution', () => {
  test('the opening mark already includes its cash movements, while closing movements belong to the session', () => {
    const evidence = fixture()
    const movement = evidence.movements[0]
    if (movement === undefined) throw new Error('Missing cash movement')
    const scope = {
      accountBindingHash: evidence.accountBindingHash,
      sessionDate: evidence.sessionDate,
      openAt: '2026-11-02T14:30:00.000Z',
      closeAt: '2026-11-02T21:00:00.000Z',
      asOf: evidence.asOf,
    }
    for (const [at, expected] of [
      ['2026-11-02T14:29:59.999Z', false],
      [scope.openAt, false],
      ['2026-11-02T14:30:00.001Z', true],
      [scope.closeAt, true],
      ['2026-11-02T21:00:00.001Z', false],
    ] as const)
      expect(cashFlowsMatchSession({ ...evidence, movements: [{ ...movement, at }] }, scope)).toBe(expected)
  })
  test('uses only movements available at the mark and keeps funding, passive yield and paid expenses separate', () => {
    const evidence = fixture()
    expect(cashFlowTotals(evidence, '2026-11-02T16:30:00.000Z')).toEqual({
      external: 900000n,
      yieldAmount: 0n,
      paidOperating: 0n,
    })
    expect(cashFlowTotals(evidence, evidence.asOf)).toEqual({
      external: 900000n,
      yieldAmount: 5000n,
      paidOperating: 20000n,
    })
    expect(Result.getOrThrow(cashFlowsSupported(evidence, verified(evidence)))).toBe(true)
  })
  test('an empty movement list needs an independently verified complete coverage artifact', () => {
    const empty = { ...fixture(), movements: [] }
    expect(Result.getOrThrow(cashFlowsSupported(empty, new Set()))).toBe(false)
    expect(Result.getOrThrow(cashFlowsSupported(empty, verified(empty)))).toBe(true)
    const incomplete = Schema.decodeUnknownSync(CashFlowEvidenceSchema)({ ...empty, coverage: 'INCOMPLETE' })
    expect(Result.getOrThrow(cashFlowsSupported(incomplete, verified(incomplete)))).toBe(false)
  })
  test('rejects duplicate, unverified, future and negative paid-expense evidence', () => {
    const original = fixture()
    const first = original.movements[0]
    if (first === undefined) throw new Error('Missing cash movement fixture')
    const cases = [
      { ...original, movements: [...original.movements, first] },
      { ...original, movements: [{ ...first, at: '2026-11-03T00:00:00.000Z' }] },
      { ...original, movements: [{ ...first, kind: CashAdjustmentKind.PaidOperatingCost, amountMicros: '-1' }] },
    ]
    for (const evidence of cases)
      expect(Result.getOrThrow(cashFlowsSupported(evidence, verified(evidence)))).toBe(false)
    const sources = verified(original)
    sources.delete(first.sourceHash)
    expect(Result.getOrThrow(cashFlowsSupported(original, sources))).toBe(false)
  })
})
