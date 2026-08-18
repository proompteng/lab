import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Result } from 'effect'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  OrderClass,
  OrderSide as BrokerOrderSide,
  OrderStatus,
  OrderType as BrokerOrderType,
  PositionSide,
  TimeInForce as BrokerTimeInForce,
  type Account,
  type BrokerReadShape,
  type Order,
  type Position,
  type ReadEvidence,
  type ReadResult,
} from '../broker/alpaca'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import type { BrokerMutationShape } from '../broker/alpaca-mutations'
import type { CancelReceipt, SubmitReceipt } from '../broker/alpaca-mutations/model'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from './contracts'
import {
  BrokerAccess,
  grantedCapitalAuthority,
  makeExecutionAuthority,
  makeCapitalGrantRecord,
  type ExecutionStrategyIdentity,
  type GrantedCapitalAuthority,
  type ExecutionCapitalLimits,
  type MutationExecutionAuthority,
} from './authority'
import {
  isPersistedGrantExecutionAuthority,
  makeAuthorityGuardedBrokerMutation,
  refreshExecutionBrokerSubmitSnapshot,
  validateExecutionBrokerSubmitSnapshot,
  validatePersistedCapitalGrantForSubmit,
  type FinalSubmitAuthorization,
} from './mutation-authority'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const activeAt = '2026-07-28T08:00:00.000Z'
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const defaultLimits: ExecutionCapitalLimits = {
  maxGrossNotionalMicros: '1000000000',
  maxOrderNotionalMicros: '500000000',
  maxPositionNotionalMicros: '750000000',
  maxDailyLossMicros: '100000000',
  maxOpenOrders: 5,
}
const evidence: ReadEvidence = {
  requestId: 'mutation-authority-test',
  status: 200,
  contentHash: '4'.repeat(64),
  observedAt: activeAt,
}
const readResult = <A>(value: A, observedAt: string = evidence.observedAt): ReadResult<A> => ({
  value,
  evidence: { ...evidence, observedAt },
})

const account = (overrides: Partial<Account> = {}): Account => ({
  id: accountId,
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  lastEquityMicros: '1000000000',
  buyingPowerMicros: '1000000000',
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  observedAt: activeAt,
  ...overrides,
})

const position = (overrides: Partial<Position> = {}): Position => ({
  accountId,
  assetId: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: 'AMD',
  exchange: AssetExchange.Nasdaq,
  assetClass: AssetClass.UsEquity,
  side: PositionSide.Long,
  quantityMicros: '1000000',
  averageEntryPriceMicros: '100000000',
  marketPriceMicros: '100000000',
  marketValueMicros: '100000000',
  unrealizedPnlMicros: '0',
  observedAt: activeAt,
  ...overrides,
})

type OmittedOrderField =
  | 'filledAveragePriceMicros'
  | 'limitPriceMicros'
  | 'notionalMicros'
  | 'quantityMicros'
  | 'stopPriceMicros'

const order = (overrides: Partial<Order> = {}, omitted: readonly OmittedOrderField[] = []): Order => {
  const value: Order = {
    accountId,
    brokerOrderId: '61e69015-8549-4bfd-b9c3-01e75843f47d',
    clientOrderId: 'open-order-1',
    createdAt: activeAt,
    submittedAt: activeAt,
    assetId: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
    symbol: 'AMD',
    assetClass: AssetClass.UsEquity,
    quantityMicros: '1000000',
    notionalMicros: '100000000',
    filledQuantityMicros: '0',
    orderClass: OrderClass.Simple,
    orderType: BrokerOrderType.Market,
    side: BrokerOrderSide.Buy,
    timeInForce: BrokerTimeInForce.Day,
    status: OrderStatus.New,
    extendedHours: false,
    observedAt: activeAt,
    ...overrides,
  }
  for (const field of omitted) Reflect.deleteProperty(value, field)
  return value
}

const intent = (overrides: Partial<Intent> = {}): Intent => ({
  schemaVersion: 'bayn.paper-intent.v3',
  intentId: '5'.repeat(64),
  authorityGenerationHash,
  riskDecisionId: '6'.repeat(64),
  strategyName: strategy.name,
  cycleId: '7'.repeat(64),
  decisionHash: '8'.repeat(64),
  policyHash: '9'.repeat(64),
  accountId,
  clientOrderId: 'mutation-authority-intent',
  symbol: 'AMD',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  notionalLimitMicros: '100000000',
  state: IntentState.Approved,
  createdAt: activeAt,
  ...overrides,
})

const identity = (environment: BrokerEnvironment) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId,
    }),
  )

const persistedGrantRecord = (
  limits: ExecutionCapitalLimits = defaultLimits,
  environment: BrokerEnvironment = BrokerEnvironment.Live,
) =>
  Result.getOrThrow(
    makeCapitalGrantRecord({
      schemaVersion: 'bayn.capital-grant.v2',
      brokerIdentity: identity(environment),
      authorityGenerationHash,
      strategy,
      limits,
      validFrom: '2026-07-28T07:00:00.000Z',
      validUntil: '2026-07-28T09:00:00.000Z',
      issuedAt: '2026-07-28T06:00:00.000Z',
      issuedBy: 'operator:test',
    }),
  )

const mutationAuthority = (
  environment: BrokerEnvironment,
  capitalAuthority: GrantedCapitalAuthority,
): MutationExecutionAuthority => {
  const constructed = makeExecutionAuthority({
    brokerIdentity: identity(environment),
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority,
    strategy,
    observedAt: activeAt,
  })
  if (Result.isFailure(constructed) || constructed.success.brokerAccess !== BrokerAccess.Mutation) {
    throw new Error('mutation authority fixture must construct')
  }
  return constructed.success
}

const submitReceipt: SubmitReceipt = {
  requestHash: 'a'.repeat(64),
  order: order({ status: OrderStatus.Accepted }),
  evidence: {
    requestId: 'submit-receipt',
    status: 200,
    contentHash: 'b'.repeat(64),
    observedAt: activeAt,
  },
}
const cancelReceipt: CancelReceipt = {
  requestHash: 'c'.repeat(64),
  brokerOrderId: order().brokerOrderId,
  evidence: {
    requestId: 'cancel-receipt',
    status: 204,
    contentHash: 'd'.repeat(64),
    observedAt: activeAt,
  },
}

interface ScenarioInput {
  readonly environment?: BrokerEnvironment
  readonly grant?: ReturnType<typeof persistedGrantRecord>
  readonly persisted?: GrantedCapitalAuthority | undefined
  readonly observedAt?: string
  readonly accountObservedAt?: string
  readonly positionsObservedAt?: string
  readonly ordersObservedAt?: string
  readonly brokerAccount?: Account
  readonly brokerAccountAtRead?: (orderReads: number) => Account
  readonly positions?: readonly Position[]
  readonly positionSnapshots?: readonly (readonly Position[])[]
  readonly openOrders?: readonly Order[]
  readonly orderSnapshots?: readonly (readonly Order[])[]
  readonly proposedIntent?: Intent
  readonly persistedAtRead?: (positionReads: number) => GrantedCapitalAuthority | undefined
  readonly finalSubmitAuthorization?: FinalSubmitAuthorization
}

const runLiveSubmit = async (input: ScenarioInput = {}) => {
  const environment = input.environment ?? BrokerEnvironment.Live
  const grant = input.grant ?? persistedGrantRecord(defaultLimits, environment)
  const trace: string[] = []
  let submits = 0
  let grantReads = 0
  let positionReads = 0
  let orderReads = 0
  let orderLimit: number | undefined
  const unusedRead = Effect.die(new Error('unused broker read in mutation authority test'))
  const brokerRead: BrokerReadShape = {
    account: Effect.sync(() => {
      trace.push('account')
      return readResult(
        input.brokerAccountAtRead?.(orderReads) ?? input.brokerAccount ?? account(),
        input.accountObservedAt,
      )
    }),
    accountConfiguration: unusedRead,
    assetBySymbol: () => unusedRead,
    positions: Effect.sync(() => {
      trace.push('positions')
      const snapshots = input.positionSnapshots
      const positions = snapshots?.[Math.min(positionReads, snapshots.length - 1)] ?? input.positions ?? []
      positionReads += 1
      return readResult(positions, input.positionsObservedAt)
    }),
    orders: (query) =>
      Effect.sync(() => {
        trace.push('orders')
        orderLimit = query?.limit
        const snapshots = input.orderSnapshots
        const orders = snapshots?.[Math.min(orderReads, snapshots.length - 1)] ?? input.openOrders ?? []
        orderReads += 1
        return readResult(orders, input.ordersObservedAt)
      }),
    orderById: () => unusedRead,
    orderByClientId: () => unusedRead,
    fillActivities: () => unusedRead,
    marketCalendar: () => unusedRead,
  }
  const brokerMutation: BrokerMutationShape = {
    submit: () =>
      Effect.sync(() => {
        trace.push('submit')
        submits += 1
        return submitReceipt
      }),
    cancel: () => Effect.succeed(cancelReceipt),
  }
  const authority = mutationAuthority(environment, grantedCapitalAuthority(grant))
  if (!isPersistedGrantExecutionAuthority(authority)) {
    throw new Error('persisted submit fixture requires persisted-grant authority')
  }
  const persistedCapitalGrants = {
    read: () =>
      Effect.sync(() => {
        trace.push('grant')
        grantReads += 1
        if (input.persistedAtRead !== undefined) return input.persistedAtRead(positionReads)
        return input.persisted === undefined && !('persisted' in input)
          ? grantedCapitalAuthority(grant)
          : input.persisted
      }),
  }
  const currentUtcInstant = Effect.sync(() => {
    trace.push('clock')
    return input.observedAt ?? activeAt
  })
  const finalSubmitAuthorization: FinalSubmitAuthorization =
    input.finalSubmitAuthorization ??
    ((proposedIntent, transmit) =>
      Effect.gen(function* () {
        const snapshot = yield* refreshExecutionBrokerSubmitSnapshot(grant.limits, proposedIntent, {
          brokerRead,
        })
        const persisted = yield* persistedCapitalGrants.read()
        if (persisted === undefined) return yield* Effect.fail({ _tag: 'PersistedCapitalGrantMissing' as const })
        const observedAt = yield* currentUtcInstant
        const freshAuthority = validatePersistedCapitalGrantForSubmit(authority, persisted, observedAt)
        if (Result.isFailure(freshAuthority)) return yield* Effect.fail(freshAuthority.failure)
        const validation = validateExecutionBrokerSubmitSnapshot(
          freshAuthority.success,
          freshAuthority.success.capitalAuthority.persistedGrant.grant.limits,
          proposedIntent,
          snapshot,
          observedAt,
          { closeOnly: false, maxBrokerStateAgeMs: 300_000 },
        )
        if (Result.isFailure(validation)) return yield* Effect.fail(validation.failure)
        trace.push('authorize')
        return yield* transmit
      }))
  const guarded = makeAuthorityGuardedBrokerMutation(authority, {
    brokerMutation,
    finalSubmitAuthorization,
  })
  const exit = await Effect.runPromiseExit(guarded.submit(input.proposedIntent ?? intent()))
  return { exit, grant, grantReads, orderLimit, orderReads, positionReads, submits, trace }
}

const failureTag = (exit: Awaited<ReturnType<typeof runLiveSubmit>>['exit']): string | undefined => {
  if (exit._tag !== 'Failure') return undefined
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
  return failure?.cause?.['tag']
}

describe('final broker mutation authority', () => {
  test.each([BrokerEnvironment.Sandbox, BrokerEnvironment.Live])(
    'revalidates the same persisted grant contract for %s submission',
    async (environment) => {
      const observed = await runLiveSubmit({ environment })

      expect(observed.exit._tag).toBe('Success')
      expect(observed.grantReads).toBe(1)
      expect(observed.submits).toBe(1)
    },
  )

  test('refreshes exposure and the immutable grant immediately before one live submit', async () => {
    const observed = await runLiveSubmit()

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
    expect(observed.grantReads).toBe(1)
    expect(observed.positionReads).toBe(3)
    expect(observed.orderReads).toBe(3)
    expect(observed.orderLimit).toBe(defaultLimits.maxOpenOrders)
    expect(observed.trace.indexOf('grant')).toBeGreaterThan(observed.trace.lastIndexOf('positions'))
    expect(observed.trace.indexOf('clock')).toBeGreaterThan(observed.trace.indexOf('grant'))
    expect(observed.trace.indexOf('authorize')).toBeGreaterThan(observed.trace.indexOf('clock'))
    expect(observed.trace.at(-1)).toBe('submit')
  })

  test('rejects a fill that moves between the position and open-order reads', async () => {
    const filledPosition = position()
    const observed = await runLiveSubmit({
      positionSnapshots: [[], [filledPosition]],
      openOrders: [],
    })

    expect(failureTag(observed.exit)).toBe('BrokerPositionSnapshotChanged')
    expect(observed.positionReads).toBe(2)
    expect(observed.grantReads).toBe(0)
    expect(observed.submits).toBe(0)
    expect(observed.trace).toEqual(['positions', 'orders', 'positions'])
  })

  test('rejects an open order that appears while the final broker snapshot is collected', async () => {
    const competingOrder = order({
      brokerOrderId: '1d2811f4-f118-40a6-871f-7f1f0ac1fa1f',
      clientOrderId: 'external-order',
    })
    const observed = await runLiveSubmit({ orderSnapshots: [[], [competingOrder]] })

    expect(failureTag(observed.exit)).toBe('BrokerOpenOrderSnapshotChanged')
    expect(observed.orderReads).toBe(2)
    expect(observed.grantReads).toBe(0)
    expect(observed.submits).toBe(0)
  })

  test('uses account safety state observed after exposure stabilization', async () => {
    const observed = await runLiveSubmit({
      brokerAccountAtRead: (orderReads) =>
        orderReads >= 2 ? account({ tradingBlocked: true }) : account({ tradingBlocked: false }),
    })

    expect(failureTag(observed.exit)).toBe('BrokerAccountUnavailable')
    expect(observed.orderReads).toBe(3)
    expect(observed.grantReads).toBe(1)
    expect(observed.submits).toBe(0)
  })

  test('rejects exposure drift observed after the final account safety read', async () => {
    const observed = await runLiveSubmit({
      positionSnapshots: [[], [], [position()]],
    })

    expect(failureTag(observed.exit)).toBe('BrokerPositionSnapshotChanged')
    expect(observed.positionReads).toBe(3)
    expect(observed.grantReads).toBe(0)
    expect(observed.submits).toBe(0)
  })

  test('rejects open-order drift observed after the final account safety read', async () => {
    const competingOrder = order({
      brokerOrderId: 'fd3123e2-97bd-4cb8-821b-934ecad616ba',
      clientOrderId: 'post-account-external-order',
    })
    const observed = await runLiveSubmit({
      orderSnapshots: [[], [], [competingOrder]],
    })

    expect(failureTag(observed.exit)).toBe('BrokerOpenOrderSnapshotChanged')
    expect(observed.orderReads).toBe(3)
    expect(observed.grantReads).toBe(0)
    expect(observed.submits).toBe(0)
  })

  test('accepts a stable open-order set when the broker changes response ordering', async () => {
    const first = order({ brokerOrderId: '1d2811f4-f118-40a6-871f-7f1f0ac1fa1f', clientOrderId: 'external-a' })
    const second = order({ brokerOrderId: '7df7fb90-5d60-472e-9c67-a6a1664d7b44', clientOrderId: 'external-b' })
    const observed = await runLiveSubmit({
      orderSnapshots: [
        [first, second],
        [second, first],
      ],
    })

    expect(observed.exit._tag).toBe('Success')
    expect(observed.orderReads).toBe(3)
    expect(observed.submits).toBe(1)
  })

  test.each([
    ['account', { brokerAccount: account({ observedAt: '2026-07-28T07:54:59.999Z' }) }],
    ['position', { positions: [position({ observedAt: '2026-07-28T07:54:59.999Z' })] }],
    ['open order', { openOrders: [order({ observedAt: '2026-07-28T07:54:59.999Z' })] }],
    ['empty positions collection', { positionsObservedAt: '2026-07-28T07:54:59.999Z' }],
    ['empty orders collection', { ordersObservedAt: '2026-07-28T07:54:59.999Z' }],
  ] as const)('rejects stale final %s state before broker transmission', async (_name, snapshot) => {
    const observed = await runLiveSubmit(snapshot)

    expect(failureTag(observed.exit)).toBe('BrokerStateStale')
    expect(observed.submits).toBe(0)
  })

  test('rejects final broker observations from the future', async () => {
    const observed = await runLiveSubmit({ brokerAccount: account({ observedAt: '2026-07-28T08:00:00.001Z' }) })

    expect(failureTag(observed.exit)).toBe('BrokerStateObservationInFuture')
    expect(observed.submits).toBe(0)
  })

  test.each([
    ['expired', { observedAt: '2026-07-28T09:00:00.000Z' }, 'PersistedGrantExpired'],
    [
      'missing',
      {
        persisted: undefined,
      },
      'PersistedCapitalGrantMissing',
    ],
  ] as const)('blocks a %s grant after startup with no broker submit', async (_name, overrides, tag) => {
    const observed = await runLiveSubmit(overrides)

    expect(observed.exit._tag).toBe('Failure')
    expect(failureTag(observed.exit)).toBe(tag)
    expect(observed.submits).toBe(0)
  })

  test('blocks an immutable revocation reread after startup with no broker submit', async () => {
    const grant = persistedGrantRecord()
    const observed = await runLiveSubmit({
      grant,
      persisted: grantedCapitalAuthority(grant, {
        schemaVersion: 'bayn.capital-grant-revocation.v2',
        revokedAt: '2026-07-28T08:00:00.000Z',
        revokedBy: 'operator:test',
        reason: 'containment',
      }),
    })

    expect(failureTag(observed.exit)).toBe('PersistedGrantRevoked')
    expect(observed.submits).toBe(0)
  })

  test('observes a revocation that lands while broker state is collected', async () => {
    const grant = persistedGrantRecord()
    const active = grantedCapitalAuthority(grant)
    const revoked = grantedCapitalAuthority(grant, {
      schemaVersion: 'bayn.capital-grant-revocation.v2',
      revokedAt: activeAt,
      revokedBy: 'operator:test',
      reason: 'containment',
    })
    const observed = await runLiveSubmit({
      grant,
      persistedAtRead: (positionReads) => (positionReads < 2 ? active : revoked),
    })

    expect(observed.trace.indexOf('grant')).toBeGreaterThan(observed.trace.lastIndexOf('positions'))
    expect(failureTag(observed.exit)).toBe('PersistedGrantRevoked')
    expect(observed.submits).toBe(0)
  })

  test('delegates final-submit rejection before any broker preflight', async () => {
    const observed = await runLiveSubmit({
      finalSubmitAuthorization: () => Effect.fail({ _tag: 'ExpiredRiskDecision' as const }),
    })

    expect(failureTag(observed.exit)).toBe('ExpiredRiskDecision')
    expect(observed.grantReads).toBe(0)
    expect(observed.positionReads).toBe(0)
    expect(observed.submits).toBe(0)
  })

  test.each([
    ['order notional', { maxOrderNotionalMicros: '99999999' }, {}, 'OrderNotionalLimitExceeded'],
    [
      'position notional',
      { maxPositionNotionalMicros: '150000000' },
      { positions: [position()] },
      'PositionNotionalLimitExceeded',
    ],
    [
      'gross notional',
      { maxGrossNotionalMicros: '150000000' },
      { positions: [position()] },
      'GrossNotionalLimitExceeded',
    ],
    [
      'daily loss',
      { maxDailyLossMicros: '99999999' },
      { brokerAccount: account({ lastEquityMicros: '1100000000', equityMicros: '1000000000' }) },
      'DailyLossLimitExceeded',
    ],
    ['open orders', { maxOpenOrders: 1 }, { openOrders: [order()] }, 'OpenOrderLimitExceeded'],
  ] as const)(
    'enforces the live %s limit at the final boundary',
    async (_name, limitOverride, snapshotOverride, tag) => {
      const grant = persistedGrantRecord({ ...defaultLimits, ...limitOverride })
      const observed = await runLiveSubmit({ grant, ...snapshotOverride })

      expect(failureTag(observed.exit)).toBe(tag)
      expect(observed.submits).toBe(0)
    },
  )

  test('fails closed when an open order has no defensible notional', async () => {
    const observed = await runLiveSubmit({
      openOrders: [order({}, ['notionalMicros', 'quantityMicros'])],
    })

    expect(failureTag(observed.exit)).toBe('OpenOrderNotionalUnavailable')
    expect(observed.submits).toBe(0)
  })

  test('rejects a queued stop order whose triggered market fill has no enforceable price bound', async () => {
    const observed = await runLiveSubmit({
      openOrders: [
        order(
          {
            orderType: BrokerOrderType.Stop,
            quantityMicros: '1000000',
            stopPriceMicros: '100000000',
          },
          ['notionalMicros', 'limitPriceMicros', 'filledAveragePriceMicros'],
        ),
      ],
    })

    expect(failureTag(observed.exit)).toBe('OpenOrderNotionalUnavailable')
    expect(observed.submits).toBe(0)
  })

  test('rejects a queued quantity market order whose future fill has no enforceable ceiling', async () => {
    const queued = order(
      {
        brokerOrderId: 'c14cb7fb-0890-47dd-bbca-7778cfc61ec6',
        symbol: 'NVDA',
        quantityMicros: '1000000',
      },
      ['notionalMicros', 'limitPriceMicros', 'stopPriceMicros', 'filledAveragePriceMicros'],
    )
    const observed = await runLiveSubmit({ openOrders: [queued] })

    expect(failureTag(observed.exit)).toBe('OpenOrderMarketPriceUnbounded')
    expect(observed.submits).toBe(0)
  })

  test('admits an ordinary sell exit using its durable notional cap', async () => {
    const observed = await runLiveSubmit({
      positions: [position()],
      proposedIntent: intent({ side: OrderSide.Sell, notionalLimitMicros: '99000000' }),
    })

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
  })

  test('nets a reducing sell by symbol before applying the gross-exposure ceiling', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxGrossNotionalMicros: '100000000' })
    const observed = await runLiveSubmit({
      grant,
      positions: [position({ quantityMicros: '900000', marketValueMicros: '90000000' })],
      proposedIntent: intent({
        side: OrderSide.Sell,
        quantityMicros: '200000',
        notionalLimitMicros: '20000000',
      }),
    })

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
  })

  test('rejects a sell that would increase exposure through a short position', async () => {
    const observed = await runLiveSubmit({
      positions: [position({ quantityMicros: '100000', marketValueMicros: '10000000' })],
      proposedIntent: intent({
        side: OrderSide.Sell,
        quantityMicros: '200000',
        notionalLimitMicros: '20000000',
      }),
    })

    expect(failureTag(observed.exit)).toBe('IncreasingSellUnsupported')
    expect(observed.submits).toBe(0)
  })

  test('does not let a queued buy hide an overshort that can fill first', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxOrderNotionalMicros: '200000000' })
    const queuedBuy = order({
      brokerOrderId: '5ea242d9-9fa2-423b-908d-d2cccfcd5a5c',
      side: BrokerOrderSide.Buy,
      quantityMicros: '1000000',
      notionalMicros: '100000000',
    })
    const observed = await runLiveSubmit({
      grant,
      positions: [position()],
      openOrders: [queuedBuy],
      proposedIntent: intent({
        side: OrderSide.Sell,
        quantityMicros: '1500000',
        notionalLimitMicros: '150000000',
      }),
    })

    expect(failureTag(observed.exit)).toBe('IncreasingSellUnsupported')
    expect(observed.submits).toBe(0)
  })

  test('does not let a queued reducing sell subsidize a new symbol gross exposure', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxGrossNotionalMicros: '150000000' })
    const queuedSell = order({
      brokerOrderId: 'ee49ed03-d957-45f7-b725-a32d9c215cd5',
      symbol: 'NVDA',
      side: BrokerOrderSide.Sell,
      quantityMicros: '1000000',
      notionalMicros: '100000000',
    })
    const observed = await runLiveSubmit({
      grant,
      positions: [position({ symbol: 'NVDA' })],
      openOrders: [queuedSell],
    })

    expect(failureTag(observed.exit)).toBe('GrossNotionalLimitExceeded')
    expect(observed.submits).toBe(0)
  })

  test('rejects an uncovered pending sell on another symbol before authorizing a candidate buy', async () => {
    const uncoveredSell = order(
      {
        brokerOrderId: 'c87ed037-a814-4e28-aef4-57f23831a54b',
        symbol: 'NVDA',
        side: BrokerOrderSide.Sell,
        quantityMicros: '1000000',
        limitPriceMicros: '1000000',
      },
      ['notionalMicros'],
    )
    const observed = await runLiveSubmit({ openOrders: [uncoveredSell] })

    expect(failureTag(observed.exit)).toBe('PendingSellUncovered')
    expect(observed.submits).toBe(0)
  })

  test('prices only the unfilled remainder of a partially filled queued buy', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxPositionNotionalMicros: '120000000' })
    const partialBuy = order(
      {
        brokerOrderId: '2a9722db-503f-47ad-82ef-6ba5a444be52',
        side: BrokerOrderSide.Buy,
        quantityMicros: '1000000',
        filledQuantityMicros: '500000',
        limitPriceMicros: '100000000',
        status: OrderStatus.PartiallyFilled,
      },
      ['notionalMicros'],
    )
    const observed = await runLiveSubmit({
      grant,
      positions: [position({ quantityMicros: '500000', marketValueMicros: '50000000' })],
      openOrders: [partialBuy],
      proposedIntent: intent({ quantityMicros: '100000', notionalLimitMicros: '10000000' }),
    })

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
  })

  test('rejects a partially filled market-order remainder whose future fill remains unbounded', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxPositionNotionalMicros: '150000000' })
    const partialMarketBuy = order(
      {
        brokerOrderId: 'baf250d8-f7ac-48e8-b54b-1ed2fc870bf0',
        side: BrokerOrderSide.Buy,
        orderType: BrokerOrderType.Market,
        quantityMicros: '1000000',
        filledQuantityMicros: '500000',
        filledAveragePriceMicros: '100000000',
        status: OrderStatus.PartiallyFilled,
      },
      ['notionalMicros', 'limitPriceMicros', 'stopPriceMicros'],
    )
    const observed = await runLiveSubmit({
      grant,
      positions: [position({ quantityMicros: '500000', marketValueMicros: '50000000' })],
      openOrders: [partialMarketBuy],
      proposedIntent: intent({ quantityMicros: '50000', notionalLimitMicros: '10000000' }),
    })

    expect(failureTag(observed.exit)).toBe('OpenOrderMarketPriceUnbounded')
    expect(observed.submits).toBe(0)
  })

  test('uses only the unfilled remainder of a partially filled queued sell for overshort protection', async () => {
    const partialSell = order(
      {
        brokerOrderId: '318a5a2b-b976-4df3-9fbd-1030ab46e937',
        side: BrokerOrderSide.Sell,
        quantityMicros: '1000000',
        filledQuantityMicros: '500000',
        limitPriceMicros: '100000000',
        status: OrderStatus.PartiallyFilled,
      },
      ['notionalMicros'],
    )
    const observed = await runLiveSubmit({
      positions: [position()],
      openOrders: [partialSell],
      proposedIntent: intent({
        side: OrderSide.Sell,
        quantityMicros: '400000',
        notionalLimitMicros: '40000000',
      }),
    })

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
  })

  test('applies the immutable order-notional ceiling to a reducing sell', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxOrderNotionalMicros: '98999999' })
    const observed = await runLiveSubmit({
      grant,
      positions: [position()],
      proposedIntent: intent({ side: OrderSide.Sell, notionalLimitMicros: '99000000' }),
    })

    expect(failureTag(observed.exit)).toBe('OrderNotionalLimitExceeded')
    expect(observed.submits).toBe(0)
  })

  test('uses the durable notional cap rather than an unavailable broker quote', async () => {
    const grant = persistedGrantRecord({ ...defaultLimits, maxOrderNotionalMicros: '100000000' })
    const observed = await runLiveSubmit({
      grant,
      positions: [position()],
      proposedIntent: intent({ side: OrderSide.Sell, notionalLimitMicros: '90000000' }),
    })

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
  })

  test.each([
    ['account', { accountId: 'other-account' }, 'IntentAccountMismatch'],
    ['strategy', { strategyName: 'other-strategy' }, 'IntentStrategyMismatch'],
    ['authority generation', { authorityGenerationHash: 'e'.repeat(64) }, 'IntentAuthorityGenerationMismatch'],
  ] as const)('rejects intent %s drift before any broker or grant I/O', async (_name, override, tag) => {
    const observed = await runLiveSubmit({ proposedIntent: intent(override) })

    expect(failureTag(observed.exit)).toBe(tag)
    expect(observed.trace).toEqual([])
    expect(observed.grantReads).toBe(0)
    expect(observed.submits).toBe(0)
  })

  test('sandbox uses the same guard without live reads and still binds the generation', async () => {
    let reads = 0
    let grantReads = 0
    let submits = 0
    const mutation: BrokerMutationShape = {
      submit: () =>
        Effect.sync(() => {
          submits += 1
          return submitReceipt
        }),
      cancel: () => Effect.succeed(cancelReceipt),
    }
    const guarded = makeAuthorityGuardedBrokerMutation(
      mutationAuthority(BrokerEnvironment.Sandbox, grantedCapitalAuthority(authorityGenerationHash)),
      {
        brokerMutation: mutation,
        finalSubmitAuthorization: (_intent, transmit) => transmit,
      },
    )

    await Effect.runPromise(guarded.submit(intent()))
    const mismatched = await Effect.runPromiseExit(guarded.submit(intent({ authorityGenerationHash: 'e'.repeat(64) })))

    expect(submits).toBe(1)
    expect(reads).toBe(0)
    expect(grantReads).toBe(0)
    expect(mismatched._tag).toBe('Failure')
  })

  test('keeps cancellation available for containment after grant revocation', async () => {
    const grant = persistedGrantRecord()
    let cancels = 0
    let grantReads = 0
    const mutation: BrokerMutationShape = {
      submit: () => Effect.succeed(submitReceipt),
      cancel: () =>
        Effect.sync(() => {
          cancels += 1
          return cancelReceipt
        }),
    }
    const guarded = makeAuthorityGuardedBrokerMutation(
      mutationAuthority(BrokerEnvironment.Live, grantedCapitalAuthority(grant)),
      {
        brokerMutation: mutation,
        finalSubmitAuthorization: () => Effect.die(new Error('cancellation must not authorize submit')),
      },
    )

    await Effect.runPromise(guarded.cancel(order().brokerOrderId))

    expect(cancels).toBe(1)
    expect(grantReads).toBe(0)
  })
})
