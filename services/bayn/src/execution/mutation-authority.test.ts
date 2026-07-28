import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Fiber, Result } from 'effect'

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
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../paper'
import {
  BrokerAccess,
  liveCapitalAuthority,
  makeExecutionAuthority,
  makeLiveCapitalGrant,
  sandboxCapitalAuthority,
  type ExecutionStrategyIdentity,
  type LiveCapitalAuthority,
  type LiveCapitalLimits,
  type MutationExecutionAuthority,
} from './authority'
import { makeAuthorityGuardedBrokerMutation } from './mutation-authority'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const activeAt = '2026-07-28T08:00:00.000Z'
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const defaultLimits: LiveCapitalLimits = {
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
const readResult = <A>(value: A): ReadResult<A> => ({ value, evidence })

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

const order = (overrides: Partial<Order> = {}): Order => ({
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
})

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

const liveGrant = (limits: LiveCapitalLimits = defaultLimits) =>
  Result.getOrThrow(
    makeLiveCapitalGrant({
      schemaVersion: 'bayn.live-capital-grant.v1',
      brokerIdentity: identity(BrokerEnvironment.Live),
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
  capitalAuthority: LiveCapitalAuthority | ReturnType<typeof sandboxCapitalAuthority>,
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
  readonly grant?: ReturnType<typeof liveGrant>
  readonly persisted?: LiveCapitalAuthority | undefined
  readonly observedAt?: string
  readonly brokerAccount?: Account
  readonly positions?: readonly Position[]
  readonly openOrders?: readonly Order[]
  readonly proposedIntent?: Intent
}

const runLiveSubmit = async (input: ScenarioInput = {}) => {
  const grant = input.grant ?? liveGrant()
  const trace: string[] = []
  let submits = 0
  let grantReads = 0
  let orderLimit: number | undefined
  const unusedRead = Effect.die(new Error('unused broker read in mutation authority test'))
  const brokerRead: BrokerReadShape = {
    account: Effect.sync(() => {
      trace.push('account')
      return readResult(input.brokerAccount ?? account())
    }),
    accountConfiguration: unusedRead,
    assetBySymbol: () => unusedRead,
    positions: Effect.sync(() => {
      trace.push('positions')
      return readResult(input.positions ?? [])
    }),
    orders: (query) =>
      Effect.sync(() => {
        trace.push('orders')
        orderLimit = query?.limit
        return readResult(input.openOrders ?? [])
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
  const guarded = makeAuthorityGuardedBrokerMutation(
    mutationAuthority(BrokerEnvironment.Live, liveCapitalAuthority(grant)),
    {
      brokerRead,
      brokerMutation,
      liveCapitalGrants: {
        read: () =>
          Effect.sync(() => {
            trace.push('grant')
            grantReads += 1
            return input.persisted === undefined && !('persisted' in input)
              ? liveCapitalAuthority(grant)
              : input.persisted
          }),
      },
      currentUtcInstant: Effect.sync(() => {
        trace.push('clock')
        return input.observedAt ?? activeAt
      }),
    },
  )
  const exit = await Effect.runPromiseExit(guarded.submit(input.proposedIntent ?? intent()))
  return { exit, grant, grantReads, orderLimit, submits, trace }
}

const failureTag = (exit: Awaited<ReturnType<typeof runLiveSubmit>>['exit']): string | undefined => {
  if (exit._tag !== 'Failure') return undefined
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
  return failure?.cause?.tag
}

describe('final broker mutation authority', () => {
  test('refreshes exposure and the immutable grant immediately before one live submit', async () => {
    const observed = await runLiveSubmit()

    expect(observed.exit._tag).toBe('Success')
    expect(observed.submits).toBe(1)
    expect(observed.grantReads).toBe(1)
    expect(observed.orderLimit).toBe(defaultLimits.maxOpenOrders)
    expect(observed.trace.indexOf('grant')).toBeGreaterThan(observed.trace.indexOf('orders'))
    expect(observed.trace.indexOf('clock')).toBeGreaterThan(observed.trace.indexOf('grant'))
    expect(observed.trace.at(-1)).toBe('submit')
  })

  test('serializes concurrent live snapshots through broker submission', async () => {
    const grant = liveGrant({ ...defaultLimits, maxOpenOrders: 1 })
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const firstSubmitStarted = yield* Deferred.make<void>()
        const releaseFirstSubmit = yield* Deferred.make<void>()
        let openOrders: readonly Order[] = []
        let snapshotReads = 0
        let submits = 0
        const unusedRead = Effect.die(new Error('unused broker read in concurrent mutation authority test'))
        const brokerRead: BrokerReadShape = {
          account: Effect.succeed(readResult(account())),
          accountConfiguration: unusedRead,
          assetBySymbol: () => unusedRead,
          positions: Effect.succeed(readResult([])),
          orders: () =>
            Effect.sync(() => {
              snapshotReads += 1
              return readResult(openOrders)
            }),
          orderById: () => unusedRead,
          orderByClientId: () => unusedRead,
          fillActivities: () => unusedRead,
          marketCalendar: () => unusedRead,
        }
        const brokerMutation: BrokerMutationShape = {
          submit: (submittedIntent) =>
            Effect.gen(function* () {
              submits += 1
              if (submits === 1) {
                yield* Deferred.succeed(firstSubmitStarted, undefined)
                yield* Deferred.await(releaseFirstSubmit)
              }
              const accepted = order({ clientOrderId: submittedIntent.clientOrderId })
              openOrders = [...openOrders, accepted]
              return { ...submitReceipt, order: accepted }
            }),
          cancel: () => Effect.succeed(cancelReceipt),
        }
        const guarded = makeAuthorityGuardedBrokerMutation(
          mutationAuthority(BrokerEnvironment.Live, liveCapitalAuthority(grant)),
          {
            brokerRead,
            brokerMutation,
            liveCapitalGrants: { read: () => Effect.succeed(liveCapitalAuthority(grant)) },
            currentUtcInstant: Effect.succeed(activeAt),
          },
        )
        const first = yield* guarded
          .submit(intent({ intentId: 'a'.repeat(64), clientOrderId: 'concurrent-live-1' }))
          .pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(firstSubmitStarted)
        const second = yield* guarded
          .submit(intent({ intentId: 'b'.repeat(64), clientOrderId: 'concurrent-live-2' }))
          .pipe(Effect.exit, Effect.forkChild)
        yield* Effect.sleep('10 millis')
        const snapshotReadsWhileFirstBlocked = snapshotReads
        yield* Deferred.succeed(releaseFirstSubmit, undefined)
        return {
          first: yield* Fiber.join(first),
          second: yield* Fiber.join(second),
          snapshotReads,
          snapshotReadsWhileFirstBlocked,
          submits,
        }
      }),
    )

    expect(observed.snapshotReadsWhileFirstBlocked).toBe(1)
    expect(observed.snapshotReads).toBe(2)
    expect(observed.submits).toBe(1)
    expect([observed.first._tag, observed.second._tag].sort()).toEqual(['Failure', 'Success'])
    const rejected = observed.first._tag === 'Failure' ? observed.first : observed.second
    expect(rejected._tag).toBe('Failure')
    if (rejected._tag === 'Failure') {
      const failure = rejected.cause.reasons.find(Cause.isFailReason)?.error
      expect(failure?.cause?.tag).toBe('LiveOpenOrderLimitExceeded')
    }
  })

  test.each([
    ['expired', { observedAt: '2026-07-28T09:00:00.000Z' }, 'LiveGrantExpired'],
    [
      'missing',
      {
        persisted: undefined,
      },
      'LiveCapitalGrantMissing',
    ],
  ] as const)('blocks a %s grant after startup with no broker submit', async (_name, overrides, tag) => {
    const observed = await runLiveSubmit(overrides)

    expect(observed.exit._tag).toBe('Failure')
    expect(failureTag(observed.exit)).toBe(tag)
    expect(observed.submits).toBe(0)
  })

  test('blocks an immutable revocation reread after startup with no broker submit', async () => {
    const grant = liveGrant()
    const observed = await runLiveSubmit({
      grant,
      persisted: liveCapitalAuthority(grant, {
        schemaVersion: 'bayn.live-capital-grant-revocation.v1',
        revokedAt: '2026-07-28T08:00:00.000Z',
        revokedBy: 'operator:test',
        reason: 'containment',
      }),
    })

    expect(failureTag(observed.exit)).toBe('LiveGrantRevoked')
    expect(observed.submits).toBe(0)
  })

  test.each([
    ['order notional', { maxOrderNotionalMicros: '99999999' }, {}, 'LiveOrderNotionalLimitExceeded'],
    [
      'position notional',
      { maxPositionNotionalMicros: '150000000' },
      { positions: [position()] },
      'LivePositionNotionalLimitExceeded',
    ],
    [
      'gross notional',
      { maxGrossNotionalMicros: '150000000' },
      { positions: [position()] },
      'LiveGrossNotionalLimitExceeded',
    ],
    [
      'daily loss',
      { maxDailyLossMicros: '99999999' },
      { brokerAccount: account({ lastEquityMicros: '1100000000', equityMicros: '1000000000' }) },
      'LiveDailyLossLimitExceeded',
    ],
    ['open orders', { maxOpenOrders: 1 }, { openOrders: [order()] }, 'LiveOpenOrderLimitExceeded'],
  ] as const)(
    'enforces the live %s limit at the final boundary',
    async (_name, limitOverride, snapshotOverride, tag) => {
      const grant = liveGrant({ ...defaultLimits, ...limitOverride })
      const observed = await runLiveSubmit({ grant, ...snapshotOverride })

      expect(failureTag(observed.exit)).toBe(tag)
      expect(observed.submits).toBe(0)
    },
  )

  test('fails closed when an open order has no defensible notional', async () => {
    const observed = await runLiveSubmit({
      openOrders: [order({ notionalMicros: undefined, quantityMicros: undefined })],
    })

    expect(failureTag(observed.exit)).toBe('OpenOrderNotionalUnavailable')
    expect(observed.submits).toBe(0)
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
      mutationAuthority(BrokerEnvironment.Sandbox, sandboxCapitalAuthority(authorityGenerationHash)),
      {
        brokerRead: new Proxy({} as BrokerReadShape, {
          get: () => {
            reads += 1
            return Effect.die(new Error('sandbox must not read live exposure'))
          },
        }),
        brokerMutation: mutation,
        liveCapitalGrants: {
          read: () => {
            grantReads += 1
            return Effect.succeed(undefined)
          },
        },
        currentUtcInstant: Effect.die(new Error('sandbox must not read the live grant clock')),
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
    const grant = liveGrant()
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
      mutationAuthority(BrokerEnvironment.Live, liveCapitalAuthority(grant)),
      {
        brokerRead: {} as BrokerReadShape,
        brokerMutation: mutation,
        liveCapitalGrants: {
          read: () => {
            grantReads += 1
            return Effect.succeed(
              liveCapitalAuthority(grant, {
                schemaVersion: 'bayn.live-capital-grant-revocation.v1',
                revokedAt: activeAt,
                revokedBy: 'operator:test',
                reason: 'containment',
              }),
            )
          },
        },
        currentUtcInstant: Effect.succeed(activeAt),
      },
    )

    await Effect.runPromise(guarded.cancel(order().brokerOrderId))

    expect(cancels).toBe(1)
    expect(grantReads).toBe(0)
  })
})
