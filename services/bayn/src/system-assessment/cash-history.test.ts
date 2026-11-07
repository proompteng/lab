import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { testHash } from './fixtures.test-support'
import { CashAdjustmentKind, CashFlowEvidenceSchema } from './cash-flows'
import { CashHistorySchema, indexCashHistory, projectSessionCash } from './cash-history'
import { requiredValuationTimes } from './valuation'

const cashChangesAt = (history: Parameters<typeof indexCashHistory>[0], at: string) => indexCashHistory(history)(at)

const at = (seconds: number) => new Date(Date.parse('2026-11-02T14:30:00.000Z') + seconds * 1000).toISOString()
const mark = (seconds: number, cashMicros: string | null) => ({
  accountBindingHash: testHash('account'),
  sourceHash: testHash({ seconds, cashMicros }),
  at: at(seconds),
  availableAt: at(130),
  cashMicros,
  valuation: { inventorySourceHash: testHash('inventory'), positions: [] },
})
const flows = Schema.decodeUnknownSync(CashFlowEvidenceSchema)({
  schemaVersion: 'bayn.system-cash-flow-evidence.v1',
  accountBindingHash: testHash('account'),
  sessionDate: '2026-11-02',
  asOf: at(130),
  coverage: 'COMPLETE',
  movements: [],
})
const change = (start: number, end: number, amountMicros: string) => ({
  sourceHash: testHash({ start, end, amountMicros }),
  earliestAt: at(start),
  latestAt: at(end),
  amountMicros,
})
const history = Schema.decodeUnknownSync(CashHistorySchema)({
  sourceHash: testHash('history'),
  completeFrom: at(0),
  completeThrough: at(130),
  changes: [change(20, 20, '-2'), change(80, 80, '7')],
})

test('valuation schedule follows the registered decision cadence and always includes both boundaries', () => {
  expect(requiredValuationTimes([{ openAt: at(0), closeAt: at(125) }], 30_000)).toEqual([
    at(0),
    at(30),
    at(60),
    at(90),
    at(120),
    at(125),
  ])
  expect(requiredValuationTimes([{ openAt: at(0), closeAt: at(125) }], 90_000)).toEqual([at(0), at(90), at(125)])
})

test('exact boundary and minute cash comes from transactions and an independent cash observation, including backwards reconstruction', () => {
  expect(requiredValuationTimes([{ openAt: at(0), closeAt: at(125) }], 60_000)).toEqual([
    at(0),
    at(60),
    at(120),
    at(125),
  ])
  const marks = [mark(0, null), mark(30, '998'), mark(60, null), mark(90, '1005'), mark(120, null)]
  const projected = Result.getOrThrow(projectSessionCash(marks, history, flows, at(120)))
  expect(projected.map((value) => value.cashMicros)).toEqual(['1000', '998', '998', '1005', '1005'])
  expect(projected[1]).toEqual(marks[1])
  expect(projected[0]?.sourceHash).not.toBe(marks[0]?.sourceHash)
  expect(Result.getOrThrow(projectSessionCash(marks, null, flows, at(120)))).toEqual(marks)
  expect(Result.getOrThrow(projectSessionCash(marks, history, null, at(120)))).toEqual(marks)
  expect(
    Result.getOrThrow(projectSessionCash(marks, { ...history, completeThrough: at(119) }, flows, at(120))),
  ).toEqual(marks)
})

test('deposits, yield and account-paid operating costs preserve cash without becoming trading profit', () => {
  const adjustments = {
    ...flows,
    movements: [
      { kind: CashAdjustmentKind.External, time: 30, amountMicros: '100' },
      { kind: CashAdjustmentKind.PassiveYield, time: 40, amountMicros: '5' },
      { kind: CashAdjustmentKind.PaidOperatingCost, time: 50, amountMicros: '3' },
    ].map(({ time, ...movement }) => ({
      ...movement,
      at: at(time),
      sourceHash: testHash(time),
      movementId: testHash(movement),
    })),
  }
  const projected = Result.getOrThrow(
    projectSessionCash(
      [mark(0, null), mark(30, '1098'), mark(60, null), mark(90, '1107'), mark(120, null)],
      history,
      adjustments,
      at(120),
    ),
  )
  expect(projected.map((value) => value.cashMicros)).toEqual(['1000', '1098', '1100', '1107', '1107'])
})

test('unresolved fee timing is not assigned to a favorable minute and contradictions cannot be ignored', () => {
  const uncertain = { ...history, changes: [change(20, 50, '-2')] }
  const projected = Result.getOrThrow(
    projectSessionCash(
      [mark(0, null), mark(10, '1000'), mark(30, null), mark(60, null), mark(70, '998'), mark(120, null)],
      uncertain,
      flows,
      at(120),
    ),
  )
  expect(projected.map((value) => value.cashMicros)).toEqual(['1000', '1000', null, '998', '998', '998'])
  expect(cashChangesAt(uncertain, at(20))).toBeNull()
  expect(cashChangesAt(uncertain, at(50))).toBe(-2n)
  const conflict = Result.getOrThrow(
    projectSessionCash([mark(0, null), mark(30, '998'), mark(90, '1006'), mark(120, null)], history, flows, at(120)),
  )
  expect(conflict.every((value) => value.cashMicros === null)).toBe(true)
  expect(cashChangesAt({ ...history, changes: [change(20, 20, '-2'), change(20, 20, '-2')] }, at(120))).toBeNull()
  expect(cashChangesAt({ ...history, changes: [change(30, 20, '-2')] }, at(120))).toBeNull()
  expect(cashChangesAt(history, at(-1))).toBeNull()
  expect(cashChangesAt(history, at(131))).toBeNull()
  expect(cashChangesAt({ ...history, completeFrom: at(131) }, at(120))).toBeNull()
})

test('one cumulative cash index preserves overlapping uncertainty and arbitrary query order', () => {
  const changes = Array.from({ length: 40 }, (_, i) => change(i * 3, i * 3 + (i % 5), String(i % 2 === 0 ? i : -i)))
  const indexed = indexCashHistory({ ...history, changes })
  for (const second of Array.from({ length: 131 }, (_, i) => i).reverse()) {
    const instant = at(second)
    const unresolved = changes.some((change) => change.earliestAt <= instant && instant < change.latestAt)
    const expected = unresolved
      ? null
      : changes.reduce((total, change) => total + (change.latestAt <= instant ? BigInt(change.amountMicros) : 0n), 0n)
    expect(indexed(instant)).toBe(expected)
  }
})
