import { Clock, Effect, Result, Schema } from 'effect'

import {
  OrderCollection,
  OrderSide as BrokerOrderSide,
  OrderStatus as BrokerOrderStatus,
  type BrokerReadShape,
  type Order,
} from '../broker/alpaca/model'
import { BrokerOrderReadResultSchema, ObservedBrokerStateSchema } from '../broker/alpaca/observed-snapshot'
import { verifyProtectionGroup } from '../broker/alpaca/protection-group'
import type { JevExitTarget } from '../jev/exit'
import { JevPurpose } from '../jev/portfolio'
import { utcInstantFromEpochMillis } from '../time'
import { UtcInstantSchema, strictParseOptions } from '../schemas'
import { withObservedStage } from '../telemetry'
import { OrderSide, OrderStatus, isStopProtection, type Intent } from './contracts'
import { NativeProtectionCancelCommandSchema, type NativeProtectionCancelCommand } from './intents/domain'
import { validateStablePositionSnapshot } from './mutation-authority'

const terminalBrokerStatuses = new Set([
  BrokerOrderStatus.Filled,
  BrokerOrderStatus.Canceled,
  BrokerOrderStatus.Expired,
  BrokerOrderStatus.Rejected,
])

export interface ProtectionReleaseBasis {
  readonly command: NativeProtectionCancelCommand
  readonly acceptedAt: string
  readonly protectionIntent: Intent
  readonly trigger: JevExitTarget
  readonly postedFills: readonly {
    readonly orderId: string
    readonly filledQuantityAtoms: string
    readonly signedQuantityAtoms: string
  }[]
}

type ProtectionReleaseReadback = Pick<BrokerReadShape, 'orderByClientId' | 'orders' | 'positions' | 'account'>

export const VerifiedProtectionReleaseSchema = Schema.TaggedStruct('VerifiedProtectionRelease', {
  command: NativeProtectionCancelCommandSchema,
  acceptedAt: UtcInstantSchema,
  checkedAt: UtcInstantSchema,
  root: BrokerOrderReadResultSchema,
  account: ObservedBrokerStateSchema.fields.snapshot.fields.account,
  openOrders: ObservedBrokerStateSchema.fields.openOrders,
  positions: ObservedBrokerStateSchema.fields.snapshot.fields.positions,
})

const unchanged = (known: JevExitTarget['evidence']['portfolio']['brokerState']['orders'][number], current: Order) =>
  known.brokerOrderId === current.brokerOrderId &&
  known.clientOrderId === current.clientOrderId &&
  known.parentBrokerOrderId === current.parentBrokerOrderId &&
  known.accountId === current.accountId &&
  known.symbol === current.symbol &&
  known.side === (current.side === BrokerOrderSide.Buy ? OrderSide.Buy : OrderSide.Sell) &&
  known.filledQuantityAtoms === current.filledQuantityAtoms

/** A release readback proves one residual against prior posted fills; it never establishes a new account reconciliation. */
export const readProtectionRelease = (
  read: ProtectionReleaseReadback,
  basis: ProtectionReleaseBasis,
  maximumObservationAgeMs: number,
) =>
  Effect.gen(function* () {
    const { protectionIntent, command, acceptedAt, trigger, postedFills } = basis
    const portfolio = trigger.evidence.portfolio
    if (
      portfolio.purpose !== JevPurpose.Manage ||
      protectionIntent.protection === undefined ||
      isStopProtection(protectionIntent.protection) ||
      protectionIntent.intentId !== command.intentId ||
      protectionIntent.accountId !== command.accountId ||
      portfolio.brokerState.account.accountId !== command.accountId ||
      trigger.cycleId !== protectionIntent.cycleId ||
      !portfolio.protectionIntentIds.includes(command.intentId) ||
      trigger.symbols[0] !== protectionIntent.symbol ||
      trigger.observedAt > command.requestedAt ||
      command.requestedAt >= trigger.commitDeadlineAt ||
      acceptedAt < command.requestedAt
    )
      return { _tag: 'Unproven', reason: 'cancel-binding' } as const
    const state = portfolio.brokerState
    const [position] = state.positions
    if (
      state.positions.length !== 1 ||
      position?.symbol !== protectionIntent.symbol ||
      BigInt(position.quantityAtoms) === 0n ||
      postedFills.reduce((sum, fill) => sum + BigInt(fill.signedQuantityAtoms), 0n) !== BigInt(position.quantityAtoms)
    )
      return { _tag: 'Unproven', reason: 'posted-inventory' } as const
    const known = state.orders.filter(({ intentId }) => intentId === command.intentId)
    if (
      state.orders.some(
        (order) =>
          order.intentId !== command.intentId &&
          ![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(order.status),
      ) ||
      !known.some(({ brokerOrderId }) => brokerOrderId === command.brokerOrderId)
    )
      return { _tag: 'Unproven', reason: 'known-group' } as const

    const root = yield* read.orderByClientId(protectionIntent.clientOrderId)
    const legs = verifyProtectionGroup(root.value, {
      symbol: protectionIntent.symbol,
      quantityAtoms: protectionIntent.quantityAtoms,
      protection: protectionIntent.protection,
    })
    if (
      Result.isFailure(legs) ||
      root.value.clientOrderId !== protectionIntent.clientOrderId ||
      root.evidence.observedAt < acceptedAt
    )
      return { _tag: 'Unproven', reason: 'broker-group' } as const
    const group = [root.value, ...legs.success]
    if (
      known.length !== group.length ||
      !group.some(
        (order) => order.brokerOrderId === command.brokerOrderId && order.status === BrokerOrderStatus.Canceled,
      ) ||
      group.some(
        (order) =>
          !terminalBrokerStatuses.has(order.status) ||
          order.replacedBy !== undefined ||
          order.replaces !== undefined ||
          !known.some((member) => unchanged(member, order)) ||
          order.filledQuantityAtoms !==
            (postedFills.find(({ orderId }) => orderId === order.brokerOrderId)?.filledQuantityAtoms ?? '0'),
      )
    )
      return { _tag: 'Unproven', reason: 'changed-group' } as const

    const { account, openOrders, positions } = yield* Effect.all(
      {
        account: read.account,
        openOrders: read.orders({ status: OrderCollection.Open, limit: 1 }),
        positions: read.positions,
      },
      { concurrency: 3 },
    )
    const checkedAtMs = yield* Clock.currentTimeMillis
    if (
      [root, account, openOrders, positions].some(({ evidence: { observedAt } }) => {
        const age = checkedAtMs - Date.parse(observedAt)
        return !Number.isFinite(age) || age < 0 || age >= maximumObservationAgeMs
      })
    )
      return { _tag: 'Unproven', reason: 'stale-readback' } as const
    if (
      [account, openOrders, positions].some(({ evidence }) => evidence.observedAt < root.evidence.observedAt) ||
      account.value.id !== command.accountId ||
      account.value.cashMicros !== state.account.cashMicros ||
      openOrders.value.length !== 0 ||
      Result.isFailure(validateStablePositionSnapshot(state.positions, positions.value))
    )
      return { _tag: 'Unproven', reason: 'changed-account' } as const

    const readback = Schema.decodeUnknownResult(
      VerifiedProtectionReleaseSchema,
      strictParseOptions,
    )({
      _tag: 'VerifiedProtectionRelease',
      command,
      acceptedAt,
      checkedAt: utcInstantFromEpochMillis(checkedAtMs),
      root,
      account,
      openOrders,
      positions,
    })
    return Result.isSuccess(readback) ? readback.success : ({ _tag: 'Unproven', reason: 'readback-shape' } as const)
  }).pipe(
    Effect.tap((outcome) =>
      Effect.annotateCurrentSpan({
        'bayn.protection_release.outcome': outcome._tag,
        ...(outcome._tag === 'Unproven' ? { 'bayn.protection_release.reason': outcome.reason } : {}),
      }),
    ),
    withObservedStage('bayn.execution.protection-release.readback', { dependency: 'broker' }),
  )
