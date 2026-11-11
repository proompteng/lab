import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderClass, OrderStatus, OrderSide } from '../broker/alpaca/model'
import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import type { IntentBinding } from '../db/reconciliation'
import { normalizeSnapshot } from './broker-normalization'
import { normalizationFixture } from './broker-normalization.test-support'

test('normalizes protection history identically to explicit child bindings, preserving event order and identity', () => {
  const { snapshot, bindings } = normalizationFixture(100)
  const expandedBindings: IntentBinding[] = [...bindings]
  const rows = snapshot.history.orders.rows.flatMap((observed) => {
    const { legs, ...parent } = observed.value
    const binding = bindings.find((item) => item.clientOrderId === parent.clientOrderId)
    if (binding === undefined) throw new Error('missing fixture binding')
    for (const child of legs ?? []) {
      expandedBindings.push({ intentId: binding.intentId, clientOrderId: child.clientOrderId })
    }
    return [{ ...observed, value: parent }, ...(legs ?? []).map((value) => ({ ...observed, value }))]
  })
  const explicit = {
    ...snapshot,
    history: { ...snapshot.history, orders: { ...snapshot.history.orders, rows } },
  }
  const actual = Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
  expect(actual).toEqual(Result.getOrThrow(normalizeSnapshot(explicit, expandedBindings)))
  expect(actual.orderEvents.map((event) => event.order.brokerOrderId)).toEqual(
    rows.map((row) => row.value.brokerOrderId),
  )
  expect(Result.getOrThrow(normalizeSnapshot(snapshot, [...bindings].reverse()))).toEqual(actual)
  expect(Result.getOrThrow(normalizeSnapshot(snapshot, bindings))).toEqual(actual)
})

test('keeps the first duplicate binding for protection verification and retains failure precedence', () => {
  const { snapshot, bindings } = normalizationFixture(1)
  const binding = bindings[0]
  if (binding === undefined) throw new Error('missing fixture binding')
  const withoutProtection: IntentBinding = { clientOrderId: binding.clientOrderId, intentId: binding.intentId }
  const missingFirst = normalizeSnapshot(snapshot, [withoutProtection, binding])
  expect(Result.isFailure(missingFirst) && missingFirst.failure.failure).toEqual({
    _tag: 'Validation',
    reason: 'UnexpectedOrderEvent',
    detail: 'broker children have no immutable strategy protection intent',
  })
  const validFirst = normalizeSnapshot(snapshot, [binding, withoutProtection])
  expect(Result.isFailure(validFirst) && validFirst.failure.failure).toEqual({
    _tag: 'Validation',
    reason: 'DuplicateIntentClientOrderId',
    detail: `duplicate intent client order ID ${binding.clientOrderId}`,
  })
})

test('preserves missing protection failures before duplicate validation and does not reuse expanded child bindings', () => {
  const { snapshot, bindings } = normalizationFixture(2)
  const binding = bindings[0]
  if (binding === undefined) throw new Error('missing fixture binding')
  const missing = normalizeSnapshot(snapshot, [binding, binding])
  expect(Result.isFailure(missing) && missing.failure.failure).toEqual({
    _tag: 'Validation',
    reason: 'UnexpectedOrderEvent',
    detail: 'broker children have no immutable strategy protection intent',
  })
  const first = snapshot.history.orders.rows[0]
  const child = first?.value.legs?.[0]
  if (first === undefined || child === undefined) throw new Error('missing fixture child')
  const repeatedChild = {
    ...snapshot,
    history: {
      ...snapshot.history,
      orders: { ...snapshot.history.orders, rows: [first, { ...first, value: { ...child, legs: [] } }] },
    },
  }
  const result = normalizeSnapshot(repeatedChild, bindings)
  expect(Result.isFailure(result) && result.failure.failure).toEqual({
    _tag: 'Validation',
    reason: 'UnexpectedOrderEvent',
    detail: 'broker children have no immutable strategy protection intent',
  })
})

test('coalesces only a verified identical nested/standalone child regardless of row order or read metadata', () => {
  const { snapshot, bindings } = normalizationFixture(1)
  const parent = snapshot.history.orders.rows[0]!
  const { parentBrokerOrderId: _parent, ...child } = parent.value.legs![0]!
  const standalone = { ...parent, value: { ...child, observedAt: '2026-10-25T00:00:01.000Z' } }
  const expected = Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
  for (const rows of [
    [parent, standalone],
    [standalone, parent],
  ]) {
    const input = { ...snapshot, history: { ...snapshot.history, orders: { ...snapshot.history.orders, rows } } }
    expect(Result.getOrThrow(normalizeSnapshot(input, bindings))).toEqual(expected)
    expect(Result.getOrThrow(normalizeSnapshot(input, bindings))).toEqual(expected)
  }
})

test('rejects conflicting identity, economic terms, lifecycle state and ownership in an overlapping child', () => {
  const { snapshot, bindings } = normalizationFixture(1)
  const parent = snapshot.history.orders.rows[0]!
  const child = parent.value.legs![0]!
  const changes = [
    { accountId: 'other-account' },
    { status: OrderStatus.New },
    { side: OrderSide.Buy },
    { clientOrderId: 'other-client' },
    { brokerOrderId: 'other-broker' },
    { quantityAtoms: '1' },
    { filledQuantityAtoms: '1' },
    { limitPriceMicros: '1' },
    { symbol: 'QQQ' },
    { assetId: 'other-asset' },
    { parentBrokerOrderId: 'other-parent' },
    { updatedAt: '2026-10-25T00:00:01.000Z' },
    { replaces: 'other-order' },
    { filledAveragePriceMicros: '1' },
    { extendedHours: true },
  ]
  for (const change of changes) {
    const rows = [parent, { ...parent, value: { ...child, ...change } }]
    const input = { ...snapshot, history: { ...snapshot.history, orders: { ...snapshot.history.orders, rows } } }
    expect(Result.isFailure(normalizeSnapshot(input, bindings))).toBe(true)
  }
})

test('retains duplicate standalone rejection, including repeated otherwise valid aliases', () => {
  const { snapshot, bindings } = normalizationFixture(1)
  const parent = snapshot.history.orders.rows[0]!
  const child = { ...parent, value: parent.value.legs![0]! }
  for (const rows of [
    [parent, child, child],
    [parent, parent],
  ]) {
    const input = { ...snapshot, history: { ...snapshot.history, orders: { ...snapshot.history.orders, rows } } }
    expect(Result.isFailure(normalizeSnapshot(input, bindings))).toBe(true)
  }
})

test('overlap preserves distinct child orders, immutable attribution, fill identities and fee amounts', () => {
  const { snapshot, bindings } = normalizationFixture(1)
  const parent = snapshot.history.orders.rows[0]!
  const fixture = observedBrokerSnapshotFixture(
    snapshot.account.value.id,
    parent.value.observedAt,
    parent.value.createdAt,
  )
  const fill = fixture.snapshot.history.fills[0]!
  const input = {
    ...snapshot,
    history: {
      ...snapshot.history,
      fills: [{ ...fill, value: { ...fill.value, brokerOrderId: parent.value.brokerOrderId } }],
      fees: [
        {
          evidence: parent.evidence,
          value: {
            accountId: snapshot.account.value.id,
            activityId: 'fee-1',
            date: '2026-10-25',
            netAmountMicros: '-100',
          },
        },
      ],
    },
  }
  const expected = Result.getOrThrow(normalizeSnapshot(input, bindings))
  const rows = [parent, ...parent.value.legs!.map((value) => ({ ...parent, value }))]
  const overlapping = { ...input, history: { ...input.history, orders: { ...input.history.orders, rows } } }
  expect(Result.getOrThrow(normalizeSnapshot(overlapping, bindings))).toEqual(expected)
  expect(expected.orderEvents).toHaveLength(3)
  expect(expected.fillEvents).toHaveLength(1)
  expect(expected.fees).toEqual(input.history.fees)
})

test('coalesces an identical OCO stop child without losing the parent take-profit order', () => {
  const { snapshot, bindings } = normalizationFixture(1)
  const original = snapshot.history.orders.rows[0]!
  const binding = bindings[0]!
  const parent = {
    ...original,
    value: {
      ...original.value,
      orderClass: OrderClass.OneCancelsOther,
      status: OrderStatus.Canceled,
      side: OrderSide.Sell,
      filledQuantityAtoms: '0',
      limitPriceMicros: '210000000',
      legs: [original.value.legs![0]!],
    },
  }
  const ocoBindings: IntentBinding[] = [
    {
      ...binding,
      protection: {
        _tag: 'Oco',
        entryDecisionHash: 'a'.repeat(64),
        stopPriceMicros: '190000000',
        stopLimitPriceMicros: '189000000',
        profitLimitPriceMicros: '210000000',
      },
    },
  ]
  const history = { ...snapshot.history, orders: { ...snapshot.history.orders, rows: [parent] } }
  const expected = Result.getOrThrow(normalizeSnapshot({ ...snapshot, history }, ocoBindings))
  const rows = [parent, { ...parent, value: parent.value.legs[0]! }]
  expect(
    Result.getOrThrow(
      normalizeSnapshot({ ...snapshot, history: { ...history, orders: { ...history.orders, rows } } }, ocoBindings),
    ),
  ).toEqual(expected)
  expect(expected.orderEvents).toHaveLength(2)
})

test('rejects a broker child claimed by two separately valid protection groups', () => {
  const { snapshot, bindings } = normalizationFixture(2)
  const first = snapshot.history.orders.rows[0]!
  const second = snapshot.history.orders.rows[1]!
  const sharedId = first.value.legs![0]!.brokerOrderId
  const rows = [
    first,
    {
      ...second,
      value: {
        ...second.value,
        legs: second.value.legs!.map((child, index) => (index === 0 ? { ...child, brokerOrderId: sharedId } : child)),
      },
    },
  ]
  const result = normalizeSnapshot(
    { ...snapshot, history: { ...snapshot.history, orders: { ...snapshot.history.orders, rows } } },
    bindings,
  )
  expect(Result.isFailure(result) && result.failure.failure).toEqual({
    _tag: 'Validation',
    reason: 'UnexpectedOrderEvent',
    detail: 'broker child belongs to multiple protection groups',
  })
})
