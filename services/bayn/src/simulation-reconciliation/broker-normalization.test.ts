import { expect, test } from 'bun:test'
import { Result } from 'effect'

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
