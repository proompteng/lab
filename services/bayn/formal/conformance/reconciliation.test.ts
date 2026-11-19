import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { OrderClass, OrderSide, OrderStatus, OrderType, TimeInForce, type Order } from '../../src/broker/alpaca/model'
import { normalizeSnapshot } from '../../src/simulation-reconciliation/broker-normalization'
import { normalizationFixture } from '../../src/simulation-reconciliation/broker-normalization.test-support'
import { formalModelExecutable, runFormalModel } from '../../src/system-assessment/formal-model.test-support'

const formal = formalModelExecutable === undefined ? describe.skip : describe

const fieldValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return ['array', value.map(fieldValue)]
  if (typeof value === 'object' && value !== null) {
    return [
      'object',
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))
        .map(([name, field]) => [name, fieldValue(field)]),
    ]
  }
  return [typeof value, value]
}

// Retain field presence, primitive types, nested fields and array order from decoded plain objects.
const fields = (order: Order) =>
  Object.entries(order)
    .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))
    .map(([name, value]) => ({ name, value: JSON.stringify(fieldValue(value)) }))

formal('reconciliation identity correspondence', () => {
  test('only matching verified protection representations canonicalize', () => {
    const { snapshot, bindings } = normalizationFixture(1)
    const parent = snapshot.history.orders.rows[0]
    const child = parent?.value.legs?.[0]
    if (parent === undefined || child === undefined) throw Error('Missing protection fixture')
    const { parentBrokerOrderId: _parent, ...flatChild } = child
    const changes: readonly Partial<Order>[] = [
      {},
      { observedAt: '2026-10-25T00:00:01.000Z' },
      { parentBrokerOrderId: parent.value.brokerOrderId },
      { parentBrokerOrderId: 'foreign-parent' },
      { accountId: 'foreign-account' },
      { clientOrderId: 'foreign-client' },
      { assetId: 'foreign-asset' },
      { symbol: 'MSFT' },
      { createdAt: '2026-10-24T00:00:00.000Z' },
      { updatedAt: '2026-10-25T00:00:01.000Z' },
      { submittedAt: '2026-10-25T00:00:01.000Z' },
      { filledAt: '2026-10-25T00:00:01.000Z' },
      { canceledAt: '2026-10-25T00:00:01.000Z' },
      { replacedBy: 'replacement-order' },
      { replaces: 'replaced-order' },
      { quantityAtoms: '900000000' },
      { notionalMicros: '190000000' },
      { filledQuantityAtoms: '100000000' },
      { filledAveragePriceMicros: '190000000' },
      { limitPriceMicros: '188000000' },
      { stopPriceMicros: '191000000' },
      { status: OrderStatus.Filled },
      { side: OrderSide.Buy },
      { orderType: OrderType.Market },
      { orderClass: OrderClass.OneCancelsOther },
      { timeInForce: TimeInForce.GoodUntilCanceled },
      { extendedHours: true },
      { trailPercentMicros: '1000000' },
      { trailPriceMicros: '1000000' },
      { highWaterMarkMicros: '210000000' },
      { legs: [] },
    ]
    const standalone = changes.map((change): Order => ({ ...flatChild, ...change }))
    const expected = Schema.decodeUnknownSync(Schema.Array(Schema.Boolean))(
      runFormalModel(
        standalone.map((order) => ({
          operation: 'protectionObservationOverlap',
          nested: fields(child),
          standalone: fields(order),
        })),
      ),
    )
    const baseline = Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
    const observed = standalone.map((order, index) => {
      const result = normalizeSnapshot(
        {
          ...snapshot,
          history: {
            ...snapshot.history,
            orders: { ...snapshot.history.orders, rows: [parent, { ...parent, value: order }] },
          },
        },
        bindings,
      )
      if (expected[index] === true) {
        expect(Result.getOrThrow(result)).toEqual(baseline)
      }
      return Result.isSuccess(result)
    })
    expect(observed).toEqual([...expected])
    expect(observed.filter(Boolean)).toHaveLength(3)
  })

  test('a second actual order with a reused client ID remains rejected', () => {
    const { snapshot, bindings } = normalizationFixture(1)
    const parent = snapshot.history.orders.rows[0]
    const child = parent?.value.legs?.[0]
    if (parent === undefined || child === undefined) throw Error('Missing protection fixture')
    const duplicate = { ...child, brokerOrderId: 'different-broker-order' }
    const compatible = Schema.decodeUnknownSync(Schema.Boolean)(
      runFormalModel([
        {
          operation: 'brokerClientIdentityCompatible',
          leftBroker: child.brokerOrderId,
          leftClient: child.clientOrderId,
          rightBroker: duplicate.brokerOrderId,
          rightClient: duplicate.clientOrderId,
        },
      ])[0],
    )
    const result = normalizeSnapshot(
      {
        ...snapshot,
        history: {
          ...snapshot.history,
          orders: { ...snapshot.history.orders, rows: [parent, { ...parent, value: duplicate }] },
        },
      },
      bindings,
    )
    expect(compatible).toBe(false)
    expect(Result.isSuccess(result)).toBe(compatible)
    expect(Result.isFailure(result) && result.failure.failure).toMatchObject({
      _tag: 'Validation',
      reason: 'DuplicateBrokerClientOrderId',
    })
  })
})
