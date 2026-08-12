import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Exit, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  PositionSide,
  type Account,
  type BrokerReadShape,
  type Position,
  type ReadEvidence,
  type ReadResult,
} from '../broker/alpaca'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerMutationError, MutationFailure } from '../broker/alpaca-mutations'
import { canonicalHashV1Result } from '../hash'
import { BrokerMode, type Policy } from '../risk'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  liveCapitalAuthority,
  makeExecutionAuthority,
  makeLiveCapitalGrant,
  noCapitalAuthority,
  sandboxCapitalAuthority,
  type ExecutionStrategyIdentity,
} from './authority'
import {
  IntentState,
  MutationOutcome,
  OrderSide,
  OrderType,
  RiskOutcome,
  TimeInForce,
  type Intent,
  type RiskDecision,
} from './contracts'
import type { StoredIntent } from './intents'
import { authorizeFinalBrokerSubmit, makeExecutionProgram, type ExecutionProgramDependencies } from './runtime-program'
import { WriterFenceError } from './writer-fence'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const observedAt = '2026-07-28T08:00:00.000Z'
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const riskPolicy: Policy = {
  schemaVersion: 'bayn.paper-risk-policy.v2',
  accountId,
  brokerMode: BrokerMode.Paper,
  allowedSymbols: ['AMD'],
  allowedOrderTypes: [OrderType.Market],
  allowedTimeInForce: [TimeInForce.Day],
  maxOrderNotionalMicros: '10000000000',
  maxSymbolExposureMicros: '25000000000',
  maxGrossExposureMicros: '100000000000',
  maxNetExposureMicros: '100000000000',
  maxDailyTradedNotionalMicros: '200000000000',
  maxDailyLossMicros: '1000000000',
  maxDrawdownMicros: '1000000000',
  maxIntentAgeMs: 300_000,
  maxBrokerStateAgeMs: 300_000,
  maxMarketDataAgeMs: 300_000,
  maxAdverseSlippageBps: 10,
  maxOpenOrders: 1,
  decisionTtlMs: 300_000,
}
const riskPolicyHash = Result.getOrThrow(canonicalHashV1Result(riskPolicy))
const identity = (environment: BrokerEnvironment) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId,
    }),
  )

const dependencies = (label: string): ExecutionProgramDependencies => ({
  brokerRead: stableBrokerRead(),
  brokerMutation: {
    submit: () => Effect.die(new Error(`${label} submit must not run during composition proof`)),
    cancel: () => Effect.die(new Error(`${label} cancel must not run during composition proof`)),
  },
  intentStore: {} as ExecutionProgramDependencies['intentStore'],
  mutationStore: {} as ExecutionProgramDependencies['mutationStore'],
  writerFence: {} as ExecutionProgramDependencies['writerFence'],
  riskPolicy,
  liveCapitalGrants: {
    lockForSubmit: () => Effect.die(new Error(`${label} live grant lock must not run during composition proof`)),
    read: () => Effect.die(new Error(`${label} live grant read must not run during composition proof`)),
  },
  currentUtcInstant: Effect.succeed(observedAt),
})

const readEvidence: ReadEvidence = {
  requestId: 'runtime-program-test',
  status: 200,
  contentHash: '4'.repeat(64),
  observedAt,
}
const readResult = <A>(value: A): ReadResult<A> => ({ value, evidence: readEvidence })
const brokerAccount = (overrides: Partial<Account> = {}): Account => ({
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
  observedAt,
  ...overrides,
})
const brokerPosition = (overrides: Partial<Position> = {}): Position => ({
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
  observedAt,
  ...overrides,
})

const stableBrokerRead = (positions: readonly Position[] = [], account: Account = brokerAccount()): BrokerReadShape => {
  const unusedRead = Effect.die(new Error('stable broker fixture used an unrelated broker read'))
  return {
    account: Effect.succeed(readResult(account)),
    accountConfiguration: unusedRead,
    assetBySymbol: () => unusedRead,
    positions: Effect.succeed(readResult(positions)),
    orders: () => Effect.succeed(readResult([])),
    orderById: () => unusedRead,
    orderByClientId: () => unusedRead,
    fillActivities: () => unusedRead,
    marketCalendar: () => unusedRead,
  }
}

const finalLiveFixture = () => {
  const liveIdentity = identity(BrokerEnvironment.Live)
  const grant = Result.getOrThrow(
    makeLiveCapitalGrant({
      schemaVersion: 'bayn.live-capital-grant.v1',
      brokerIdentity: liveIdentity,
      authorityGenerationHash,
      strategy,
      limits: {
        maxGrossNotionalMicros: '100000000000',
        maxOrderNotionalMicros: '10000000000',
        maxPositionNotionalMicros: '25000000000',
        maxDailyLossMicros: '1000000000',
        maxOpenOrders: 5,
      },
      validFrom: '2026-07-28T07:00:00.000Z',
      validUntil: '2026-07-28T09:00:00.000Z',
      issuedAt: '2026-07-28T06:00:00.000Z',
      issuedBy: 'operator:test',
    }),
  )
  const authority = Result.getOrThrow(
    makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: liveCapitalAuthority(grant),
      strategy,
      observedAt,
    }),
  )
  if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')
  const riskDecisionId = '6'.repeat(64)
  const intent: Intent = {
    schemaVersion: 'bayn.paper-intent.v3',
    intentId: '5'.repeat(64),
    authorityGenerationHash,
    riskDecisionId,
    strategyName: strategy.name,
    cycleId: '7'.repeat(64),
    decisionHash: '8'.repeat(64),
    policyHash: riskPolicyHash,
    accountId,
    clientOrderId: `b1_${'C'.repeat(43)}`,
    symbol: 'AMD',
    side: OrderSide.Buy,
    orderType: OrderType.Market,
    timeInForce: TimeInForce.Day,
    quantityMicros: '1000000',
    notionalLimitMicros: '100000000',
    state: IntentState.IoStarted,
    createdAt: '2026-07-28T07:59:00.000Z',
  }
  const stored: StoredIntent = {
    intent,
    decision: {
      schemaVersion: 'bayn.paper-risk-decision.v1',
      decisionId: riskDecisionId,
      inputHash: 'a'.repeat(64),
      intentId: intent.intentId,
      policyHash: intent.policyHash,
      outcome: RiskOutcome.Approved,
      reasonCodes: [],
      decidedAt: '2026-07-28T07:59:00.001Z',
      expiresAt: '2026-07-28T08:30:00.000Z',
    },
    stateVersion: 4,
    updatedAt: '2026-07-28T07:59:00.002Z',
  }
  return { authority, grant, intent, stored }
}

const finalAuthorizationFailureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const failure: unknown = exit.cause.reasons.find(Cause.isFailReason)?.error
  if (failure instanceof BrokerMutationError) return failure.cause?.['tag']
  return typeof failure === 'object' && failure !== null && '_tag' in failure
    ? String((failure as { readonly _tag: unknown })._tag)
    : undefined
}

describe('same-code execution program composition', () => {
  test('uses one program factory for sandbox and live with only injected authority and adapters changed', () => {
    const sandboxIdentity = identity(BrokerEnvironment.Sandbox)
    const liveIdentity = identity(BrokerEnvironment.Live)
    const sandboxAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: sandboxIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    const grant = Result.getOrThrow(
      makeLiveCapitalGrant({
        schemaVersion: 'bayn.live-capital-grant.v1',
        brokerIdentity: liveIdentity,
        authorityGenerationHash,
        strategy,
        limits: {
          maxGrossNotionalMicros: '100000000000',
          maxOrderNotionalMicros: '10000000000',
          maxPositionNotionalMicros: '25000000000',
          maxDailyLossMicros: '1000000000',
          maxOpenOrders: 5,
        },
        validFrom: '2026-07-28T07:00:00.000Z',
        validUntil: '2026-07-28T09:00:00.000Z',
        issuedAt: '2026-07-28T06:00:00.000Z',
        issuedBy: 'operator:test',
      }),
    )
    const liveAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: liveCapitalAuthority(grant),
        strategy,
        observedAt,
      }),
    )

    const sandboxProgram = Result.getOrThrow(makeExecutionProgram(sandboxAuthority, dependencies('sandbox')))
    const liveProgram = Result.getOrThrow(makeExecutionProgram(liveAuthority, dependencies('live')))

    expect(sandboxProgram.schemaVersion).toBe('bayn.execution-program.v1')
    expect(liveProgram.schemaVersion).toBe(sandboxProgram.schemaVersion)
    expect(sandboxProgram.authority.brokerIdentity.environment).toBe(BrokerEnvironment.Sandbox)
    expect(liveProgram.authority.brokerIdentity.environment).toBe(BrokerEnvironment.Live)
    expect(sandboxProgram.authority.capitalAuthority._tag).toBe(CapitalAuthorityKind.Sandbox)
    expect(liveProgram.authority.capitalAuthority._tag).toBe(CapitalAuthorityKind.LiveGrant)
  })

  test('cannot construct a mutation program from read-only authority', () => {
    const readOnly = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: noCapitalAuthority,
        strategy,
        observedAt,
      }),
    )

    expect(makeExecutionProgram(readOnly, dependencies('read-only'))).toEqual(
      Result.fail({
        _tag: 'ExecutionProgramRequiresMutationAuthority',
        brokerAccess: BrokerAccess.ReadOnly,
      }),
    )
  })

  test('applies the same fresh broker-account safeguard to sandbox and live submissions', async () => {
    const live = finalLiveFixture()
    const sandboxAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    if (sandboxAuthority.brokerAccess !== BrokerAccess.Mutation) {
      throw new Error('fixture requires sandbox mutation authority')
    }

    for (const authority of [sandboxAuthority, live.authority]) {
      let posts = 0
      let accountReads = 0
      const brokerRead = stableBrokerRead()
      const testDependencies: ExecutionProgramDependencies = {
        ...dependencies(authority.brokerIdentity.environment),
        brokerRead: {
          ...brokerRead,
          account: Effect.sync(() => {
            accountReads += 1
            return readResult(brokerAccount({ tradingBlocked: true }))
          }),
        },
        intentStore: {
          read: () => Effect.succeed(Option.some(live.stored)),
        } as unknown as ExecutionProgramDependencies['intentStore'],
        mutationStore: {
          authorizeSubmit: () => Effect.void,
        } as unknown as ExecutionProgramDependencies['mutationStore'],
        writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
        liveCapitalGrants: {
          read: () => Effect.die(new Error('final authorization must use the locked grant read')),
          lockForSubmit:
            authority.brokerIdentity.environment === BrokerEnvironment.Live
              ? () => Effect.succeed(liveCapitalAuthority(live.grant))
              : () => Effect.die(new Error('sandbox final authorization must not read a live grant')),
        },
      }

      const exit = await Effect.runPromise(
        authorizeFinalBrokerSubmit(
          authority,
          live.intent,
          Effect.sync(() => {
            posts += 1
          }),
          testDependencies,
        ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
      )

      expect(finalAuthorizationFailureTag(exit)).toBe('BrokerAccountUnavailable')
      expect(accountReads).toBe(1)
      expect(posts).toBe(0)
    }
  })

  test('revalidates a live grant after broker refresh and before transmission', async () => {
    const fixture = finalLiveFixture()
    let instantReads = 0
    let posts = 0
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('live-grant-expiry-during-refresh'),
      intentStore: {
        read: () => Effect.succeed(Option.some(fixture.stored)),
      } as unknown as ExecutionProgramDependencies['intentStore'],
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
      liveCapitalGrants: {
        read: () => Effect.die(new Error('final authorization must use the locked grant read')),
        lockForSubmit: () => Effect.succeed(liveCapitalAuthority(fixture.grant)),
      },
      currentUtcInstant: Effect.sync(() => {
        instantReads += 1
        return instantReads === 1 ? observedAt : fixture.grant.validUntil
      }),
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        fixture.authority,
        fixture.intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(finalAuthorizationFailureTag(exit)).toBe('LiveGrantExpired')
    expect(instantReads).toBe(2)
    expect(posts).toBe(0)
  })

  test('revalidates the execution window after broker refresh and before transmission', async () => {
    const fixture = finalLiveFixture()
    const sandboxAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    if (sandboxAuthority.brokerAccess !== BrokerAccess.Mutation) {
      throw new Error('fixture requires sandbox mutation authority')
    }
    const brokerObservedAt = '2026-07-28T08:00:00.010Z'
    const expiresAt = '2026-07-28T08:00:00.020Z'
    const instants = [observedAt, brokerObservedAt, expiresAt]
    let instantReads = 0
    let posts = 0
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('execution-window-expiry-during-refresh'),
      intentStore: {
        read: () => Effect.succeed(Option.some(fixture.stored)),
      } as unknown as ExecutionProgramDependencies['intentStore'],
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
      currentUtcInstant: Effect.sync(() => instants[instantReads++] ?? expiresAt),
      entrySubmitExpiresAt: expiresAt,
      isCloseOnlyIntent: () => Effect.succeed(false),
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        sandboxAuthority,
        fixture.intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(finalAuthorizationFailureTag(exit)).toBe('ExecutionWindowExpired')
    expect(instantReads).toBe(3)
    expect(posts).toBe(0)
  })

  test('rejects a risk-policy binding mismatch before broker or grant I/O', async () => {
    const fixture = finalLiveFixture()
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')
    const intent = { ...fixture.intent, policyHash: '0'.repeat(64) }
    const stored = {
      ...fixture.stored,
      intent,
      decision: { ...fixture.stored.decision, policyHash: intent.policyHash },
    }
    let posts = 0
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('policy-mismatch'),
      brokerRead: {} as ExecutionProgramDependencies['brokerRead'],
      intentStore: {
        read: () => Effect.succeed(Option.some(stored)),
      } as unknown as ExecutionProgramDependencies['intentStore'],
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(finalAuthorizationFailureTag(exit)).toBe('ExecutionRiskPolicyHashMismatch')
    expect(posts).toBe(0)
  })

  test('expires PAPER submission authority at runtime while allowing only a precommitted close intent', async () => {
    const sandboxIdentity = identity(BrokerEnvironment.Sandbox)
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: sandboxIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')

    const { intent: sourceIntent, stored: sourceStored } = finalLiveFixture()
    const intent: Intent = { ...sourceIntent, side: OrderSide.Sell }
    const stored: StoredIntent = { ...sourceStored, intent }
    const episodeExpiresAt = '2026-07-28T08:01:00.000Z'
    const closeExpiresAt = '2026-07-28T08:16:00.000Z'
    const afterEntryBeforeClose = '2026-07-28T08:02:00.000Z'
    const afterClose = '2026-07-28T08:17:00.000Z'
    let posts = 0
    let authorizedCloseOnly: boolean | undefined
    const shared: ExecutionProgramDependencies = {
      ...dependencies('paper-lease'),
      brokerRead: stableBrokerRead([brokerPosition()]),
      intentStore: {
        read: () => Effect.succeed(Option.some(stored)),
      } as unknown as ExecutionProgramDependencies['intentStore'],
      mutationStore: {
        authorizeSubmit: (_intentId: string, closeOnly?: boolean) => {
          authorizedCloseOnly = closeOnly
          return Effect.void
        },
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: {
        backendPid: 1,
        check: Effect.void,
        transaction: (effect) => effect,
      },
      currentUtcInstant: Effect.succeed(afterEntryBeforeClose),
      entrySubmitExpiresAt: episodeExpiresAt,
      closeSubmitExpiresAt: closeExpiresAt,
    }

    const denied = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        { ...shared, isCloseOnlyIntent: () => Effect.succeed(false) },
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )
    expect(finalAuthorizationFailureTag(denied)).toBe('ExecutionWindowExpired')
    expect(authorizedCloseOnly).toBe(false)
    expect(posts).toBe(0)

    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(afterEntryBeforeClose))
        return yield* authorizeFinalBrokerSubmit(
          authority,
          intent,
          Effect.sync(() => {
            posts += 1
          }),
          { ...shared, isCloseOnlyIntent: () => Effect.succeed(true) },
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(closed).toBeUndefined()
    expect(authorizedCloseOnly).toBe(true)
    expect(posts).toBe(1)

    const closeExpired = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        {
          ...shared,
          currentUtcInstant: Effect.succeed(afterClose),
          isCloseOnlyIntent: () => Effect.succeed(true),
        },
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )
    expect(finalAuthorizationFailureTag(closeExpired)).toBe('ExecutionWindowExpired')
    expect(posts).toBe(1)
  })

  test('preserves policy limit exemptions for a freshly verified exposure-reducing close', async () => {
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')
    const source = finalLiveFixture()
    const closePolicy: Policy = {
      ...riskPolicy,
      maxOrderNotionalMicros: '99999999',
      maxDailyLossMicros: '99999999',
    }
    const policyHash = Result.getOrThrow(canonicalHashV1Result(closePolicy))
    const intent: Intent = { ...source.intent, side: OrderSide.Sell, policyHash }
    if (source.stored.decision === undefined) throw new Error('fixture requires an approved risk decision')
    const stored: StoredIntent = {
      ...source.stored,
      intent,
      decision: { ...source.stored.decision, policyHash },
    }
    let posts = 0
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('close-policy-exemption'),
      riskPolicy: closePolicy,
      brokerRead: stableBrokerRead(
        [brokerPosition()],
        brokerAccount({ lastEquityMicros: '1100000000', equityMicros: '1000000000' }),
      ),
      intentStore: {
        read: () => Effect.succeed(Option.some(stored)),
      } as unknown as ExecutionProgramDependencies['intentStore'],
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
      isCloseOnlyIntent: () => Effect.succeed(true),
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(exit._tag).toBe('Success')
    expect(posts).toBe(1)

    const shortElsewhere = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        {
          ...testDependencies,
          brokerRead: stableBrokerRead([
            brokerPosition(),
            brokerPosition({
              assetId: '7781125b-04ba-4fcb-903f-ad4c34eb6832',
              symbol: 'NVDA',
              side: PositionSide.Short,
              quantityMicros: '-2000000',
              marketValueMicros: '-200000000',
            }),
          ]),
        },
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(finalAuthorizationFailureTag(shortElsewhere)).toBe('OrderNotionalLimitExceeded')
    expect(posts).toBe(1)
  })

  test('keeps a distinct live-grant order cap on an exposure-reducing close', async () => {
    const liveIdentity = identity(BrokerEnvironment.Live)
    const grant = Result.getOrThrow(
      makeLiveCapitalGrant({
        schemaVersion: 'bayn.live-capital-grant.v1',
        brokerIdentity: liveIdentity,
        authorityGenerationHash,
        strategy,
        limits: {
          maxGrossNotionalMicros: '100000000000',
          maxOrderNotionalMicros: '99999999',
          maxPositionNotionalMicros: '25000000000',
          maxDailyLossMicros: '1000000000',
          maxOpenOrders: 5,
        },
        validFrom: '2026-07-28T07:00:00.000Z',
        validUntil: '2026-07-28T09:00:00.000Z',
        issuedAt: '2026-07-28T06:00:00.000Z',
        issuedBy: 'operator:test',
      }),
    )
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: liveCapitalAuthority(grant),
        strategy,
        observedAt,
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')
    const source = finalLiveFixture()
    const intent: Intent = { ...source.intent, side: OrderSide.Sell }
    const stored: StoredIntent = { ...source.stored, intent }
    let posts = 0
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('close-grant-cap'),
      brokerRead: stableBrokerRead([brokerPosition()]),
      intentStore: {
        read: () => Effect.succeed(Option.some(stored)),
      } as unknown as ExecutionProgramDependencies['intentStore'],
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
      liveCapitalGrants: {
        read: () => Effect.die(new Error('final authorization must use the locked grant read')),
        lockForSubmit: () => Effect.succeed(liveCapitalAuthority(grant)),
      },
      isCloseOnlyIntent: () => Effect.succeed(true),
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(finalAuthorizationFailureTag(exit)).toBe('OrderNotionalLimitExceeded')
    expect(posts).toBe(0)
  })

  test('rechecks risk expiry after a blocking live-grant lock and performs zero broker posts', async () => {
    const liveIdentity = identity(BrokerEnvironment.Live)
    const expiresAt = '2026-07-28T08:00:00.010Z'
    const grant = Result.getOrThrow(
      makeLiveCapitalGrant({
        schemaVersion: 'bayn.live-capital-grant.v1',
        brokerIdentity: liveIdentity,
        authorityGenerationHash,
        strategy,
        limits: {
          maxGrossNotionalMicros: '100000000000',
          maxOrderNotionalMicros: '10000000000',
          maxPositionNotionalMicros: '25000000000',
          maxDailyLossMicros: '1000000000',
          maxOpenOrders: 5,
        },
        validFrom: '2026-07-28T07:00:00.000Z',
        validUntil: '2026-07-28T09:00:00.000Z',
        issuedAt: '2026-07-28T06:00:00.000Z',
        issuedBy: 'operator:test',
      }),
    )
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: liveCapitalAuthority(grant),
        strategy,
        observedAt,
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')
    const intentId = 'a'.repeat(64)
    const decisionId = 'b'.repeat(64)
    const intent: Intent = {
      schemaVersion: 'bayn.paper-intent.v3',
      intentId,
      authorityGenerationHash,
      riskDecisionId: decisionId,
      strategyName: strategy.name,
      cycleId: 'c'.repeat(64),
      decisionHash: 'd'.repeat(64),
      policyHash: riskPolicyHash,
      accountId,
      clientOrderId: `b1_${'A'.repeat(43)}`,
      symbol: 'AMD',
      side: OrderSide.Buy,
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      quantityMicros: '1000000',
      notionalLimitMicros: '100000000',
      state: IntentState.IoStarted,
      createdAt: '2026-07-28T07:59:00.000Z',
    }
    const decision: RiskDecision = {
      schemaVersion: 'bayn.paper-risk-decision.v1',
      decisionId,
      inputHash: 'f'.repeat(64),
      intentId,
      policyHash: intent.policyHash,
      outcome: RiskOutcome.Approved,
      reasonCodes: [],
      decidedAt: '2026-07-28T07:59:00.001Z',
      expiresAt,
    }
    const stored: StoredIntent = {
      intent,
      decision,
      stateVersion: 4,
      updatedAt: '2026-07-28T07:59:00.002Z',
    }
    let reads = 0
    let locks = 0
    let posts = 0
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('final-risk'),
      intentStore: {
        commit: () => Effect.die(new Error('final risk proof must not commit')),
        read: () =>
          Effect.sync(() => {
            reads += 1
            return Option.some(stored)
          }),
      },
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: {
        backendPid: 1,
        check: Effect.void,
        transaction: (effect) => effect,
      },
      liveCapitalGrants: {
        read: () => Effect.die(new Error('final risk proof must use the locked grant read')),
        lockForSubmit: () =>
          Effect.sync(() => {
            locks += 1
          }).pipe(Effect.andThen(TestClock.setTime(Date.parse(expiresAt))), Effect.as(liveCapitalAuthority(grant))),
      },
      currentUtcInstant: Effect.succeed(observedAt),
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(expiresAt) - 1)
        return yield* authorizeFinalBrokerSubmit(
          authority,
          intent,
          Effect.sync(() => {
            posts += 1
          }),
          testDependencies,
        ).pipe(Effect.exit)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(reads).toBe(2)
    expect(locks).toBe(1)
    expect(posts).toBe(0)
  })

  test('rejects a post-lock position snapshot change with zero broker posts', async () => {
    const { authority, grant, intent, stored } = finalLiveFixture()
    const trace: string[] = []
    let positionReads = 0
    let posts = 0
    const unusedRead = Effect.die(new Error('post-lock position proof used an unrelated broker read'))
    const brokerRead: BrokerReadShape = {
      account: Effect.sync(() => {
        trace.push('account')
        return readResult(brokerAccount())
      }),
      accountConfiguration: unusedRead,
      assetBySymbol: () => unusedRead,
      positions: Effect.sync(() => {
        trace.push('positions')
        positionReads += 1
        return readResult(positionReads === 1 ? [] : [brokerPosition()])
      }),
      orders: () =>
        Effect.sync(() => {
          trace.push('orders')
          return readResult([])
        }),
      orderById: () => unusedRead,
      orderByClientId: () => unusedRead,
      fillActivities: () => unusedRead,
      marketCalendar: () => unusedRead,
    }
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('post-lock-position'),
      brokerRead,
      intentStore: {
        commit: () => Effect.die(new Error('post-lock position proof must not commit')),
        read: () => Effect.succeed(Option.some(stored)),
      },
      mutationStore: { authorizeSubmit: () => Effect.void } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
      liveCapitalGrants: {
        read: () => Effect.die(new Error('post-lock position proof must use the locked grant read')),
        lockForSubmit: () =>
          Effect.sync(() => {
            trace.push('lock')
            return liveCapitalAuthority(grant)
          }),
      },
      currentUtcInstant: Effect.succeed(observedAt),
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(finalAuthorizationFailureTag(exit)).toBe('BrokerPositionSnapshotChanged')
    expect(trace).toEqual(['lock', 'account', 'positions', 'orders', 'positions'])
    expect(posts).toBe(0)
  })

  test('does not require an unavailable quote after the broker snapshot is stable', async () => {
    const { authority, grant, intent, stored } = finalLiveFixture()
    const trace: string[] = []
    let posts = 0
    const unusedRead = Effect.die(new Error('post-lock quote proof used an unrelated broker read'))
    const brokerRead: BrokerReadShape = {
      account: Effect.sync(() => {
        trace.push('account')
        return readResult(brokerAccount())
      }),
      accountConfiguration: unusedRead,
      assetBySymbol: () => unusedRead,
      positions: Effect.sync(() => {
        trace.push('positions')
        return readResult([])
      }),
      orders: () =>
        Effect.sync(() => {
          trace.push('orders')
          return readResult([])
        }),
      orderById: () => unusedRead,
      orderByClientId: () => unusedRead,
      fillActivities: () => unusedRead,
      marketCalendar: () => unusedRead,
    }
    const authorizationObservedAt = '2026-07-28T08:00:06.000Z'
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('post-lock-quote'),
      brokerRead,
      intentStore: {
        commit: () => Effect.die(new Error('post-lock quote proof must not commit')),
        read: () => Effect.succeed(Option.some(stored)),
      },
      mutationStore: { authorizeSubmit: () => Effect.void } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: { backendPid: 1, check: Effect.void, transaction: (effect) => effect },
      liveCapitalGrants: {
        read: () => Effect.die(new Error('post-lock quote proof must use the locked grant read')),
        lockForSubmit: () =>
          Effect.sync(() => {
            trace.push('lock')
            return liveCapitalAuthority(grant)
          }),
      },
      currentUtcInstant: Effect.succeed(authorizationObservedAt),
    }

    const exit = await Effect.runPromise(
      authorizeFinalBrokerSubmit(
        authority,
        intent,
        Effect.sync(() => {
          posts += 1
        }),
        testDependencies,
      ).pipe(Effect.exit, Effect.provide(TestClock.layer())),
    )

    expect(exit._tag).toBe('Success')
    expect(trace).toEqual(['lock', 'account', 'positions', 'orders', 'positions'])
    expect(posts).toBe(1)
  })

  test('keeps a post-transmit transaction failure unknown for broker recovery', async () => {
    const sandboxIdentity = identity(BrokerEnvironment.Sandbox)
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: sandboxIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('fixture requires mutation authority')
    const intentId = '7'.repeat(64)
    const decisionId = '8'.repeat(64)
    const intent: Intent = {
      schemaVersion: 'bayn.paper-intent.v3',
      intentId,
      authorityGenerationHash,
      riskDecisionId: decisionId,
      strategyName: strategy.name,
      cycleId: '9'.repeat(64),
      decisionHash: 'a'.repeat(64),
      policyHash: riskPolicyHash,
      accountId,
      clientOrderId: `b1_${'B'.repeat(43)}`,
      symbol: 'AMD',
      side: OrderSide.Buy,
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      quantityMicros: '1000000',
      notionalLimitMicros: '100000000',
      state: IntentState.IoStarted,
      createdAt: '2026-07-28T07:59:00.000Z',
    }
    const decision: RiskDecision = {
      schemaVersion: 'bayn.paper-risk-decision.v1',
      decisionId,
      inputHash: 'c'.repeat(64),
      intentId,
      policyHash: intent.policyHash,
      outcome: RiskOutcome.Approved,
      reasonCodes: [],
      decidedAt: '2026-07-28T07:59:00.001Z',
      expiresAt: '2026-07-28T08:01:00.000Z',
    }
    const stored: StoredIntent = {
      intent,
      decision,
      stateVersion: 4,
      updatedAt: '2026-07-28T07:59:00.002Z',
    }
    let posts = 0
    const commitFailure = new WriterFenceError({
      failure: 'unavailable',
      operation: 'transaction',
      message: 'injected commit acknowledgement loss',
    })
    const testDependencies: ExecutionProgramDependencies = {
      ...dependencies('post-transmit'),
      intentStore: {
        commit: () => Effect.die(new Error('post-transmit proof must not commit an intent')),
        read: () => Effect.succeed(Option.some(stored)),
      },
      mutationStore: {
        authorizeSubmit: () => Effect.void,
      } as unknown as ExecutionProgramDependencies['mutationStore'],
      writerFence: {
        backendPid: 1,
        check: Effect.void,
        transaction: (effect) => effect.pipe(Effect.andThen(Effect.fail(commitFailure))),
      },
      currentUtcInstant: Effect.succeed(observedAt),
    }

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* Effect.flip(
          authorizeFinalBrokerSubmit(
            authority,
            intent,
            Effect.sync(() => {
              posts += 1
            }),
            testDependencies,
          ),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(posts).toBe(1)
    expect(failure).toBeInstanceOf(BrokerMutationError)
    expect(failure).toMatchObject({
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
    })
  })
})
