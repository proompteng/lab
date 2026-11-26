import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import {
  AssetClass,
  AssetExchange,
  OrderClass,
  OrderSide as BrokerOrderSide,
  OrderStatus as BrokerOrderStatus,
  PositionSide,
  type Order as BrokerOrder,
  type Position,
} from '../broker/alpaca/model'
import { orderObservation } from '../broker/observations'
import type { IntentBinding } from '../db/intent-bindings'
import type { ReconciliationPassResult } from '../reconciler'
import { normalizeSnapshot } from '../simulation-reconciliation/broker-normalization'
import { normalizationFixture } from '../simulation-reconciliation/broker-normalization.test-support'
import type { ReconciledProtectionGroup } from '../simulation-reconciliation/broker-reconciler-model'
import { makeBrokerStateCache } from './broker-state-cache'
import { cachedBrokerStateFixture, nativeBrokerStateFixture } from './broker-state-cache.fixture'
import { OrderStatus, type NativeProtection } from './contracts'
import { reconciledOpenProtectionOrders } from './reconciled-protection-orders'

const fixture = (directions: readonly boolean[] = [false]): ReconciliationPassResult => {
  const seed = normalizationFixture(directions.length)
  const bindings: IntentBinding[] = seed.bindings.map((binding, i) => ({
    ...binding,
    symbol: `SYM${i}`,
    protection: directions[i]
      ? {
          _tag: 'EquityShortBracket',
          stopPriceMicros: '210000000',
          stopLimitPriceMicros: '211000000',
          profitLimitPriceMicros: '190000000',
        }
      : {
          _tag: 'Bracket',
          stopPriceMicros: '190000000',
          stopLimitPriceMicros: '189000000',
          profitLimitPriceMicros: '210000000',
        },
  }))
  const rows = seed.snapshot.history.orders.rows.map((observed) => {
    const i = bindings.findIndex((binding) => binding.clientOrderId === observed.value.clientOrderId)
    const symbol = `SYM${i}`
    const short = directions[i] === true
    const children = (observed.value.legs ?? []).map((child, j) => ({
      ...child,
      symbol,
      side: short ? BrokerOrderSide.Buy : BrokerOrderSide.Sell,
      status: BrokerOrderStatus.New,
      limitPriceMicros: short ? (j === 0 ? '211000000' : '190000000') : j === 0 ? '189000000' : '210000000',
      ...(j === 0 ? { stopPriceMicros: short ? '210000000' : '190000000' } : {}),
    }))
    return {
      ...observed,
      value: { ...observed.value, symbol, side: short ? BrokerOrderSide.Sell : BrokerOrderSide.Buy, legs: children },
    }
  })
  const snapshot = {
    ...seed.snapshot,
    history: { ...seed.snapshot.history, orders: { ...seed.snapshot.history.orders, rows } },
  }
  const normalized = Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
  const account = snapshot.account.value
  const positions: readonly Position[] = bindings.map((binding, i) => ({
    accountId: account.id,
    assetId: `asset-${i}`,
    symbol: binding.symbol ?? '',
    exchange: AssetExchange.Nasdaq,
    assetClass: AssetClass.UsEquity,
    side: directions[i] ? PositionSide.Short : PositionSide.Long,
    quantityAtoms: directions[i] ? '-1000000000' : '1000000000',
    averageEntryPriceMicros: '200000000',
    costBasisMicros: directions[i] ? '-200000000' : '200000000',
    marketPriceMicros: '200000000',
    marketValueMicros: directions[i] ? '-200000000' : '200000000',
    unrealizedPnlMicros: '0',
    observedAt: account.observedAt,
  }))
  const result = nativeBrokerStateFixture(cachedBrokerStateFixture(account, positions))
  return {
    ...result,
    brokerState: { ...result.brokerState, orders: normalized.orderEvents.map((event) => event.order) },
    protectionGroups: normalized.protectionGroups,
  }
}

const changeGroup = (
  result: ReconciliationPassResult,
  change: (group: ReconciledProtectionGroup) => ReconciledProtectionGroup,
): ReconciliationPassResult => {
  const first = result.protectionGroups?.[0]
  if (first === undefined) throw new Error('missing protection fixture')
  const group = change(first)
  const orders = [group.parent.value, ...(group.parent.value.legs ?? [])].map((order) => {
    const event = Result.getOrThrow(orderObservation(order, group.parent.evidence, group.intentId))
    if (event._tag !== 'Order') throw new Error('unexpected fixture event')
    return event.order
  })
  return { ...result, protectionGroups: [group], brokerState: { ...result.brokerState, orders } }
}

const changeParent = (result: ReconciliationPassResult, change: (order: BrokerOrder) => BrokerOrder) =>
  changeGroup(result, (group) => ({ ...group, parent: { ...group.parent, value: change(group.parent.value) } }))

describe('reconciled protection order reuse', () => {
  test.each([false, true])('retains both real protection children of a fully filled bracket (short=%s)', (short) => {
    const result = fixture([short])
    const parent = result.protectionGroups?.[0]?.parent.value
    expect(parent).toBeDefined()
    expect(reconciledOpenProtectionOrders(result)).toEqual(parent?.legs ?? [])
  })

  test('a later basket leg can consume one exact version with concurrent long and short protection groups', async () => {
    const result = fixture([false, true])
    const cache = makeBrokerStateCache(result.brokerState.account.accountId, '1'.repeat(64))
    await Effect.runPromise(cache.record(result))
    const cached = await Effect.runPromise(cache.take(result.report.reconciliation.reconciledAt, 1000))
    expect(cached.openOrders).toEqual((result.protectionGroups ?? []).flatMap((group) => group.parent.value.legs ?? []))
    expect(cached.openOrders).toHaveLength(4)
    expect(cached.state.orders).toHaveLength(6)
    await Effect.runPromise(cache.record(result))
    expect(
      Exit.isFailure(await Effect.runPromiseExit(cache.take(result.report.reconciliation.reconciledAt, 1000))),
    ).toBe(true)
  })

  test.each([false, true])('retains provider bracket-class children after the parent fills (short=%s)', (short) => {
    // Alpaca's Create Order bracket example labels both nested children order_class=bracket.
    const result = changeParent(fixture([short]), (parent) => ({
      ...parent,
      legs: (parent.legs ?? []).map((child) => ({ ...child, orderClass: OrderClass.Bracket })),
    }))
    expect(reconciledOpenProtectionOrders(result)).toEqual(result.protectionGroups?.[0]?.parent.value.legs ?? [])
  })

  test.each([OrderClass.OneCancelsOther, OrderClass.OneTriggersOther, OrderClass.MultiLeg])(
    'an unrelated %s child class cannot impersonate a bracket child',
    (orderClass) => {
      const result = changeParent(fixture(), (parent) => ({
        ...parent,
        legs: (parent.legs ?? []).map((child) => ({ ...child, orderClass })),
      }))
      expect(reconciledOpenProtectionOrders(result)).toBeNull()
    },
  )

  test('missing original proof, a duplicate group, or an unbound active order cannot use the cache', () => {
    const result = fixture()
    const active = result.brokerState.orders.find((order) => order.status === OrderStatus.New)
    if (active === undefined) throw new Error('missing active fixture')
    expect(reconciledOpenProtectionOrders({ ...result, protectionGroups: [] })).toBeNull()
    expect(
      reconciledOpenProtectionOrders({
        ...result,
        protectionGroups: [...(result.protectionGroups ?? []), ...(result.protectionGroups ?? [])],
      }),
    ).toBeNull()
    expect(
      reconciledOpenProtectionOrders({
        ...result,
        brokerState: {
          ...result.brokerState,
          orders: [...result.brokerState.orders, { ...active, brokerOrderId: 'unbound', clientOrderId: 'unbound' }],
        },
      }),
    ).toBeNull()
  })

  test.each([
    [
      'unfinished parent',
      (parent: BrokerOrder) => ({ ...parent, status: BrokerOrderStatus.New, filledQuantityAtoms: '0' }),
    ],
    ['non-root parent', (parent: BrokerOrder) => ({ ...parent, parentBrokerOrderId: 'foreign-parent' })],
    ['foreign account', (parent: BrokerOrder) => ({ ...parent, accountId: 'foreign-account' })],
    [
      'changed immutable profit',
      (parent: BrokerOrder) => ({
        ...parent,
        legs: (parent.legs ?? []).map((child, i) => (i === 1 ? { ...child, limitPriceMicros: '220000000' } : child)),
      }),
    ],
    [
      'foreign child parent',
      (parent: BrokerOrder) => ({
        ...parent,
        legs: (parent.legs ?? []).map((child) => ({ ...child, parentBrokerOrderId: 'foreign-parent' })),
      }),
    ],
    ['missing protection sibling', (parent: BrokerOrder) => ({ ...parent, legs: (parent.legs ?? []).slice(0, 1) })],
    [
      'canceled protection sibling',
      (parent: BrokerOrder) => ({
        ...parent,
        legs: (parent.legs ?? []).map((child, i) =>
          i === 1 ? { ...child, status: BrokerOrderStatus.Canceled } : child,
        ),
      }),
    ],
    [
      'changed child direction',
      (parent: BrokerOrder) => ({
        ...parent,
        legs: (parent.legs ?? []).map((child) => ({ ...child, side: BrokerOrderSide.Buy })),
      }),
    ],
    [
      'excess child size',
      (parent: BrokerOrder) => ({
        ...parent,
        legs: (parent.legs ?? []).map((child) => ({ ...child, quantityAtoms: '2000000000' })),
      }),
    ],
  ] as const)('rejects %s even when the flattened state contains the same changed order', (_name, change) => {
    expect(reconciledOpenProtectionOrders(changeParent(fixture(), change))).toBeNull()
  })

  test('immutable terms and exact normalized state remain independent required proofs', () => {
    const result = fixture()
    const changedTerms: NativeProtection = {
      _tag: 'Bracket',
      stopPriceMicros: '190000000',
      stopLimitPriceMicros: '189000000',
      profitLimitPriceMicros: '220000000',
    }
    expect(
      reconciledOpenProtectionOrders(changeGroup(result, (group) => ({ ...group, protection: changedTerms }))),
    ).toBeNull()
    for (const change of [
      { intentId: 'f'.repeat(64) },
      { limitPriceMicros: '220000000' },
      { parentBrokerOrderId: 'unrelated' },
      { clientOrderId: 'unrelated' },
      { quantityAtoms: '2000000000' },
    ]) {
      expect(
        reconciledOpenProtectionOrders({
          ...result,
          brokerState: {
            ...result.brokerState,
            orders: result.brokerState.orders.map((order) =>
              order.status === OrderStatus.New ? { ...order, ...change } : order,
            ),
          },
        }),
      ).toBeNull()
    }
  })

  test.each(['0', '-1000000000', '500000000'])(
    'rejects protective exits not covered by the signed position %s',
    (quantityAtoms) => {
      const result = fixture()
      expect(
        reconciledOpenProtectionOrders({
          ...result,
          brokerState: {
            ...result.brokerState,
            positions: result.brokerState.positions.map((position) => ({ ...position, quantityAtoms })),
          },
        }),
      ).toBeNull()
    },
  )
})
