import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Fiber, Ref, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { config, fixtureLock, provenance, successfulJournal, readyState, recoveringStore } from './app-test-support'
import {
  AccountStatus,
  BrokerProvider,
  BrokerReadError,
  BrokerReadErrorKind,
  OrderCollection,
  SortDirection,
  type Account,
  type AccountConfigurationObservation,
  type BrokerReadOperation,
  type BrokerReadShape,
  type FillActivitiesQuery,
  type OrdersQuery,
  type ReadResult,
} from './broker/alpaca'
import { BrokerEnvironment, makeBrokerIdentity } from './broker/identity'
import {
  CycleOperationsCondition,
  CycleOperationsReason,
  decideMonthEndCadenceEligibility,
  type CycleOperationsProjection,
} from './cycle/observability'
import { CycleState, CycleTerminalReason } from './cycle'
import { CycleNotDueReason } from './cycle/runner/model'
import { currentUtcInstant } from './time'
import { CycleObservability, type CycleObservabilityShape } from './cycle/store'
import { DatabaseError, EvidenceStore } from './db/evidence-store'
import { BrokerAccess, CapitalAuthorityKind } from './execution/authority'
import { ExecutionControllerOutcome } from './execution/controller-status'
import { Authority, KillState, ReconciliationStatus } from './execution/contracts'
import {
  deriveHealthLogDecisions,
  deriveHealthTransition,
  checkHealth,
  runHealthMonitor,
  type BrokerProbe,
  ensureDurableEvidence,
  ensureSignalIdentity,
  renderDurableEvidenceFailure,
  renderSignalIdentityFailure,
  validateDurableEvidence,
  validateSignalIdentity,
} from './health'
import { readinessResponseDecision, statusFacts } from './http'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { initialState, isReady, type RuntimeState } from './runtime-state'
import { makeSnapshot } from './test-fixtures'

const testHealthDependencies = Effect.all({
  marketData: MarketData,
  journal: Journal,
  evidenceStore: EvidenceStore,
  cycleObservability: CycleObservability,
})

const probe = (
  runtimeConfig: typeof config,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  cycleFiber?: Fiber.Fiber<void, never>,
  cycleObservationId?: string,
  qualificationEvidenceRequired = true,
) =>
  testHealthDependencies.pipe(
    Effect.flatMap((dependencies) =>
      checkHealth(
        runtimeConfig,
        state,
        dependencies,
        broker,
        cycleFiber,
        cycleObservationId,
        qualificationEvidenceRequired,
      ),
    ),
  )

const monitor = (
  runtimeConfig: typeof config,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  cycleFiber?: Fiber.Fiber<void, never>,
) =>
  testHealthDependencies.pipe(
    Effect.flatMap((dependencies) => runHealthMonitor(runtimeConfig, state, dependencies, broker, cycleFiber)),
  )

const brokerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const brokerObservedAt = '2026-07-20T00:00:00.000Z'
const controllerPlanHash = 'd'.repeat(64)
const availableClock = (checkedAt: string) =>
  ({ _tag: 'Available', checkedAt, checkedAtMs: Date.parse(checkedAt) }) as const
const unsafeClock = (observedAtMs: number) =>
  ({
    _tag: 'Unavailable',
    observedAtMs,
    failure: Number.isSafeInteger(observedAtMs)
      ? ({ _tag: 'UtcEpochMillisOutOfRange', epochMillis: observedAtMs } as const)
      : ({ _tag: 'UtcEpochMillisNotSafeInteger', epochMillis: observedAtMs } as const),
  }) as const
const brokerReadResult = <A>(value: A, requestId: string): ReadResult<A> => ({
  value,
  evidence: {
    requestId,
    status: 200,
    contentHash: 'a'.repeat(64),
    observedAt: brokerObservedAt,
  },
})

const accountResult = (
  id = brokerAccountId,
  overrides: Partial<Pick<Account, 'status' | 'accountBlocked' | 'tradingBlocked' | 'tradeSuspendedByUser'>> = {},
): ReadResult<Account> =>
  brokerReadResult(
    {
      id,
      status: overrides.status ?? AccountStatus.Active,
      currency: 'USD',
      cashMicros: '1000000',
      equityMicros: '1000000',
      lastEquityMicros: '1000000',
      buyingPowerMicros: '1000000',
      accountBlocked: overrides.accountBlocked ?? false,
      tradingBlocked: overrides.tradingBlocked ?? false,
      tradeSuspendedByUser: overrides.tradeSuspendedByUser ?? false,
      observedAt: brokerObservedAt,
    },
    'broker-health-account',
  )

const accountConfigurationResult = (fractionalTrading = true): ReadResult<AccountConfigurationObservation> =>
  brokerReadResult(
    {
      schemaVersion: 'bayn.alpaca-account-configuration-observation.v1',
      source: 'alpaca-v2-account-configurations',
      requestHash: 'b'.repeat(64),
      fractionalTrading,
      observedAt: brokerObservedAt,
      normalizedResponseHash: 'c'.repeat(64),
    },
    'broker-health-account-configuration',
  )

type BrokerHealthReadName =
  | 'account'
  | 'account-configuration'
  | 'positions'
  | 'open-orders'
  | 'recent-orders'
  | 'recent-fills'

interface BrokerReadControl {
  accountId: string
  accountStatus: AccountStatus
  accountBlocked: boolean
  tradingBlocked: boolean
  tradeSuspendedByUser: boolean
  fractionalTrading: boolean
  unavailable: BrokerHealthReadName | null
  malformed: BrokerHealthReadName | null
  readonly reads: BrokerHealthReadName[]
  readonly orderQueries: OrdersQuery[]
  readonly fillQueries: FillActivitiesQuery[]
  readonly unexpectedReads: string[]
}

const brokerReadControl = (): BrokerReadControl => ({
  accountId: brokerAccountId,
  accountStatus: AccountStatus.Active,
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  fractionalTrading: true,
  unavailable: null,
  malformed: null,
  reads: [],
  orderQueries: [],
  fillQueries: [],
  unexpectedReads: [],
})

const brokerReadOperation = (name: BrokerHealthReadName): BrokerReadOperation => {
  switch (name) {
    case 'account':
      return 'account'
    case 'account-configuration':
      return 'account-configuration'
    case 'positions':
      return 'positions'
    case 'open-orders':
    case 'recent-orders':
      return 'orders'
    case 'recent-fills':
      return 'fill-activities'
  }
}

const controlledBrokerRead = <A>(
  control: BrokerReadControl,
  name: BrokerHealthReadName,
  value: () => ReadResult<A>,
): Effect.Effect<ReadResult<A>, BrokerReadError> =>
  Effect.suspend(() => {
    control.reads.push(name)
    if (control.unavailable === name) return Effect.die(new Error(`injected ${name} failure`))
    if (control.malformed === name) {
      return Effect.fail(
        new BrokerReadError({
          operation: brokerReadOperation(name),
          kind: BrokerReadErrorKind.InvalidResponse,
          message: `injected malformed ${name} response`,
          retryable: false,
        }),
      )
    }
    return Effect.succeed(value())
  })

const brokerRead = (control: BrokerReadControl): BrokerReadShape => {
  const unexpected = <A>(operation: string): Effect.Effect<A> =>
    Effect.sync(() => control.unexpectedReads.push(operation)).pipe(
      Effect.andThen(Effect.die(new Error(`continuous broker health must not call ${operation}`))),
    )
  return {
    account: controlledBrokerRead(control, 'account', () =>
      accountResult(control.accountId, {
        status: control.accountStatus,
        accountBlocked: control.accountBlocked,
        tradingBlocked: control.tradingBlocked,
        tradeSuspendedByUser: control.tradeSuspendedByUser,
      }),
    ),
    accountConfiguration: controlledBrokerRead(control, 'account-configuration', () =>
      accountConfigurationResult(control.fractionalTrading),
    ),
    assetBySymbol: (symbol) => unexpected(`asset lookup for ${symbol}`),
    positions: controlledBrokerRead(control, 'positions', () => brokerReadResult([], 'broker-health-positions')),
    orders: (query = {}) => {
      control.orderQueries.push(query)
      if (query.status === OrderCollection.Open && query.limit === 1 && query.direction === undefined) {
        return controlledBrokerRead(control, 'open-orders', () => brokerReadResult([], 'broker-health-open-orders'))
      }
      if (query.status === OrderCollection.All && query.limit === 1 && query.direction === SortDirection.Descending) {
        return controlledBrokerRead(control, 'recent-orders', () => brokerReadResult([], 'broker-health-recent-orders'))
      }
      return unexpected(`orders query ${JSON.stringify(query)}`)
    },
    orderById: (orderId) => unexpected(`order lookup by id ${orderId}`),
    orderByClientId: (clientOrderId) => unexpected(`order lookup by client id ${clientOrderId}`),
    fillActivities: (query = {}) => {
      control.fillQueries.push(query)
      if (query.pageSize === 1 && query.direction === SortDirection.Descending) {
        return controlledBrokerRead(control, 'recent-fills', () =>
          brokerReadResult({ items: [] }, 'broker-health-recent-fills'),
        )
      }
      return unexpected(`fill activities query ${JSON.stringify(query)}`)
    },
    marketCalendar: (query) => unexpected(`market calendar ${query.start}..${query.end}`),
  }
}

const brokerHealthReadNames = [
  'account',
  'account-configuration',
  'positions',
  'open-orders',
  'recent-orders',
  'recent-fills',
] as const satisfies readonly BrokerHealthReadName[]

const brokerHealthReadBehaviors: Record<BrokerHealthReadName, string> = {
  account: 'account read',
  'account-configuration': 'account configuration read',
  positions: 'positions read',
  'open-orders': 'open orders read',
  'recent-orders': 'recent orders read',
  'recent-fills': 'recent fills read',
}

const makePendingBrokerRead = (): Effect.Effect<{
  readonly read: BrokerReadShape
  readonly allStarted: Deferred.Deferred<void>
  readonly finalizations: Record<BrokerHealthReadName, number>
}> =>
  Effect.gen(function* () {
    const allStarted = yield* Deferred.make<void>()
    const started = yield* Ref.make(0)
    const finalizations: Record<BrokerHealthReadName, number> = {
      account: 0,
      'account-configuration': 0,
      positions: 0,
      'open-orders': 0,
      'recent-orders': 0,
      'recent-fills': 0,
    }
    const pending = <A>(name: BrokerHealthReadName): Effect.Effect<A> =>
      Ref.updateAndGet(started, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === brokerHealthReadNames.length ? Deferred.succeed(allStarted, undefined) : Effect.void,
        ),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            finalizations[name] += 1
          }),
        ),
      )
    const unexpected = <A>(operation: string): Effect.Effect<A> =>
      Effect.die(new Error(`pending continuous broker health must not call ${operation}`))
    const read: BrokerReadShape = {
      account: pending('account'),
      accountConfiguration: pending('account-configuration'),
      assetBySymbol: (symbol) => unexpected(`asset lookup for ${symbol}`),
      positions: pending('positions'),
      orders: (query = {}) =>
        query.status === OrderCollection.Open && query.limit === 1 && query.direction === undefined
          ? pending('open-orders')
          : query.status === OrderCollection.All && query.limit === 1 && query.direction === SortDirection.Descending
            ? pending('recent-orders')
            : unexpected(`orders query ${JSON.stringify(query)}`),
      orderById: (orderId) => unexpected(`order lookup by id ${orderId}`),
      orderByClientId: (clientOrderId) => unexpected(`order lookup by client id ${clientOrderId}`),
      fillActivities: (query = {}) =>
        query.pageSize === 1 && query.direction === SortDirection.Descending
          ? pending('recent-fills')
          : unexpected(`fill activities query ${JSON.stringify(query)}`),
      marketCalendar: (query) => unexpected(`market calendar ${query.start}..${query.end}`),
    }
    return { read, allStarted, finalizations }
  })

const brokerProbe = (read: BrokerReadShape): BrokerProbe => ({
  read,
  expectedAccountId: brokerAccountId,
  executionEligible: false,
  executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
})

const brokerRuntimeState = (broker: BrokerProbe, startedAt: string): RuntimeState => ({
  ...readyState(),
  autonomousCycleLoop: {
    configured: true,
    startedAt,
    lastPass: { result: 'SUCCESS', observedAt: startedAt, outcome: 'NO_PUBLICATION' },
  },
  broker: initialState({ broker, autonomousCycleLoopConfigured: true }).broker,
})

const emptyCycleProjection = (): CycleOperationsProjection => ({
  current: null,
  last: null,
  unfinishedCycleCount: 0,
  authority: null,
  reconciliation: null,
  mutations: {
    eventCount: 0,
    recoveryFoundCount: 0,
    approvedIntentCount: 0,
    acknowledgedIntentCount: 0,
    unresolvedCount: 0,
    oldestUnresolvedAt: null,
    latestOccurredAt: null,
  },
})

const pendingCycle = (updatedAt: string) =>
  ({
    cycleId: '1'.repeat(64),
    accountId: 'paper-account-1',
    signalSessionDate: '2026-07-17',
    executionSessionDate: '2026-07-20',
    phase: CycleState.Pending,
    snapshotId: '2'.repeat(64),
    decisionHash: null,
    terminalReason: null,
    submissionOpenAt: '2026-07-20T00:00:00.000Z',
    submissionCutoffAt: '2026-07-20T01:00:00.000Z',
    executionOpenAt: '2026-07-20T01:02:00.000Z',
    executionCloseAt: '2026-07-20T20:00:00.000Z',
    createdAt: updatedAt,
    updatedAt,
    terminalAt: null,
  }) as const

const cycleObservability = (
  read: CycleObservabilityShape['read'] = () => Effect.succeed(emptyCycleProjection()),
): CycleObservabilityShape => ({ read })

const provideHealthyDependencies = (
  initial: RuntimeState,
  effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability>,
) =>
  effect.pipe(
    Effect.provideService(MarketData, {
      check: Effect.succeed(makeSnapshot().manifest.finalizedSnapshot),
      inspect: Effect.die(new Error('health probes must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health probes must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health probes must not inspect bound cycle publications')),
      loadSnapshotPublication: () => Effect.die(new Error('health probes must not load bound cycle bars')),
      load: Effect.die(new Error('health probes must not load bars')),
    }),
    Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
    Effect.provideService(EvidenceStore, recoveringStore(initial)),
    Effect.provideService(CycleObservability, cycleObservability()),
  )

describe('Bayn continuous health', () => {
  test('returns structured signal and durable evidence invariant failures', () => {
    const current = readyState()
    const evidence = current.evidence
    expect(evidence).not.toBeNull()
    if (evidence === null) return
    const snapshot = makeSnapshot().manifest.finalizedSnapshot
    const observedSnapshotId = 'f'.repeat(64)
    const observedPublicationId = 'e'.repeat(64)

    expect(validateSignalIdentity(snapshot, null)).toEqual(Result.fail({ _tag: 'EvidenceUnavailable' }))
    expect(renderSignalIdentityFailure({ _tag: 'EvidenceUnavailable' })).toBe('startup evidence is unavailable')
    expect(validateSignalIdentity({ ...snapshot, snapshotId: observedSnapshotId }, evidence)).toEqual(
      Result.fail({
        _tag: 'SnapshotMismatch',
        observedSnapshotId,
        expectedSnapshotId: evidence.evaluation.input.snapshotId,
      }),
    )
    expect(
      renderSignalIdentityFailure({
        _tag: 'SnapshotMismatch',
        observedSnapshotId,
        expectedSnapshotId: evidence.evaluation.input.snapshotId,
      }),
    ).toBe(
      `configured Signal snapshot ${observedSnapshotId} differs from active run snapshot ${evidence.evaluation.input.snapshotId}`,
    )
    expect(validateSignalIdentity({ ...snapshot, publicationId: observedPublicationId }, evidence)).toEqual(
      Result.fail({
        _tag: 'PublicationMismatch',
        observedPublicationId,
        expectedPublicationId: evidence.evaluation.input.publicationId,
      }),
    )
    expect(
      renderSignalIdentityFailure({
        _tag: 'PublicationMismatch',
        observedPublicationId,
        expectedPublicationId: evidence.evaluation.input.publicationId,
      }),
    ).toBe(
      `configured Signal publication ${observedPublicationId} differs from active run publication ${evidence.evaluation.input.publicationId}`,
    )
    expect(validateSignalIdentity(snapshot, evidence)).toEqual(Result.succeed(undefined))

    const recovered = {
      evaluation: evidence.evaluation,
      reconciliation: evidence.reconciliation,
      persistence: { ...evidence.persistence, deduplicated: true },
    }
    const qualification = {
      state: 'TERMINAL' as const,
      lock: fixtureLock,
      result: evidence.qualification,
    }
    expect(validateDurableEvidence(null, null, null)).toEqual(Result.fail({ _tag: 'EvidenceUnavailable' }))
    expect(renderDurableEvidenceFailure({ _tag: 'EvidenceUnavailable' })).toBe('startup evidence is unavailable')
    expect(validateDurableEvidence(null, qualification, evidence)).toEqual(
      Result.fail({
        _tag: 'RunMissing',
        runId: evidence.evaluation.runId,
      }),
    )
    expect(renderDurableEvidenceFailure({ _tag: 'RunMissing', runId: evidence.evaluation.runId })).toBe(
      `durable run ${evidence.evaluation.runId} is missing`,
    )
    expect(validateDurableEvidence(recovered, null, evidence)).toEqual(
      Result.fail({
        _tag: 'TerminalQualificationMissing',
        runId: evidence.evaluation.runId,
        observedState: null,
      }),
    )
    expect(
      renderDurableEvidenceFailure({
        _tag: 'TerminalQualificationMissing',
        runId: evidence.evaluation.runId,
        observedState: null,
      }),
    ).toBe(`terminal qualification ${evidence.evaluation.runId} is missing`)
    const incompleteQualification = { state: 'OPENED_INCOMPLETE' as const, lock: fixtureLock }
    expect(validateDurableEvidence(recovered, incompleteQualification, evidence)).toEqual(
      Result.fail({
        _tag: 'TerminalQualificationMissing',
        runId: evidence.evaluation.runId,
        observedState: 'OPENED_INCOMPLETE',
      }),
    )
    expect(
      renderDurableEvidenceFailure({
        _tag: 'TerminalQualificationMissing',
        runId: evidence.evaluation.runId,
        observedState: 'OPENED_INCOMPLETE',
      }),
    ).toBe(`qualification ${evidence.evaluation.runId} is OPENED_INCOMPLETE, expected TERMINAL`)
    const mismatch = validateDurableEvidence(
      {
        ...recovered,
        persistence: { ...recovered.persistence, eventCount: recovered.persistence.eventCount + 1 },
      },
      qualification,
      evidence,
    )
    expect(Result.isFailure(mismatch)).toBe(true)
    expect(Result.isFailure(mismatch) ? mismatch.failure._tag : null).toBe('RunMismatch')
    if (Result.isFailure(mismatch) && mismatch.failure._tag === 'RunMismatch') {
      expect(mismatch.failure).toMatchObject({
        runId: evidence.evaluation.runId,
        observedDurableHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expectedDurableHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(mismatch.failure.observedDurableHash).not.toBe(mismatch.failure.expectedDurableHash)
      expect(renderDurableEvidenceFailure(mismatch.failure)).toBe(
        `durable run ${evidence.evaluation.runId} hash ${mismatch.failure.observedDurableHash} differs from active proof hash ${mismatch.failure.expectedDurableHash}`,
      )
    }

    const qualificationMismatch = validateDurableEvidence(
      recovered,
      {
        ...qualification,
        result: { ...qualification.result, resultHash: '0'.repeat(64) },
      },
      evidence,
    )
    expect(Result.isFailure(qualificationMismatch)).toBe(true)
    expect(Result.isFailure(qualificationMismatch) ? qualificationMismatch.failure._tag : null).toBe(
      'TerminalQualificationMismatch',
    )
    if (
      Result.isFailure(qualificationMismatch) &&
      qualificationMismatch.failure._tag === 'TerminalQualificationMismatch'
    ) {
      expect(qualificationMismatch.failure).toMatchObject({
        runId: evidence.evaluation.runId,
        observedQualificationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expectedQualificationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(qualificationMismatch.failure.observedQualificationHash).not.toBe(
        qualificationMismatch.failure.expectedQualificationHash,
      )
      expect(renderDurableEvidenceFailure(qualificationMismatch.failure)).toBe(
        `terminal qualification ${evidence.evaluation.runId} hash ${qualificationMismatch.failure.observedQualificationHash} differs from active proof hash ${qualificationMismatch.failure.expectedQualificationHash}`,
      )
    }

    const malformedEvidence = {
      ...evidence,
      persistence: { ...evidence.persistence, runId: '\ud800' },
    }
    const totality = Result.try(() => validateDurableEvidence(recovered, qualification, malformedEvidence))
    expect(Result.isSuccess(totality)).toBe(true)
    if (Result.isSuccess(totality)) {
      const canonicalization = totality.success
      expect(Result.isFailure(canonicalization) ? canonicalization.failure._tag : null).toBe('CanonicalizationFailed')
      if (Result.isFailure(canonicalization) && canonicalization.failure._tag === 'CanonicalizationFailed') {
        expect(canonicalization.failure.runId).toBe(evidence.evaluation.runId)
        expect(canonicalization.failure.material).toBe('EXPECTED_DURABLE_EVIDENCE')
        expect(canonicalization.failure.cause).toEqual({
          _tag: 'CanonicalJsonFailure',
          path: '$.persistence.runId',
          reason: 'invalid-unicode-surrogate',
          actualType: 'string',
        })
        expect(renderDurableEvidenceFailure(canonicalization.failure)).toBe(
          `canonicalization of EXPECTED_DURABLE_EVIDENCE for run ${evidence.evaluation.runId} failed: invalid-unicode-surrogate at $.persistence.runId (string)`,
        )
      }
    }
    expect(validateDurableEvidence(recovered, qualification, evidence)).toEqual(Result.succeed(undefined))
  })

  test('retains structured invariant failures as OperationalError causes', async () => {
    const current = readyState()
    const evidence = current.evidence
    expect(evidence).not.toBeNull()
    if (evidence === null) return
    const snapshot = makeSnapshot().manifest.finalizedSnapshot
    const observedSnapshotId = 'f'.repeat(64)
    const signalFailure = {
      _tag: 'SnapshotMismatch' as const,
      observedSnapshotId,
      expectedSnapshotId: evidence.evaluation.input.snapshotId,
    }

    const signalError = await Effect.runPromise(
      Effect.flip(ensureSignalIdentity({ ...snapshot, snapshotId: observedSnapshotId }, evidence)),
    )
    expect(signalError).toMatchObject({
      component: 'market-data',
      operation: 'check-identity',
      message: `Signal identity check failed: ${renderSignalIdentityFailure(signalFailure)}`,
      retryable: false,
      cause: signalFailure,
    })

    const recovered = {
      evaluation: evidence.evaluation,
      reconciliation: evidence.reconciliation,
      persistence: { ...evidence.persistence, deduplicated: true },
    }
    const qualification = {
      state: 'TERMINAL' as const,
      lock: fixtureLock,
      result: evidence.qualification,
    }
    const malformedEvidence = {
      ...evidence,
      persistence: { ...evidence.persistence, runId: '\ud800' },
    }
    const durableError = await Effect.runPromise(
      Effect.flip(ensureDurableEvidence(recovered, qualification, malformedEvidence)),
    )
    expect(durableError).toMatchObject({
      component: 'database',
      operation: 'verify-evidence',
      retryable: false,
      cause: {
        _tag: 'CanonicalizationFailed',
        runId: evidence.evaluation.runId,
        material: 'EXPECTED_DURABLE_EVIDENCE',
      },
    })
    const durableCause = durableError.cause
    if (
      durableCause !== null &&
      typeof durableCause === 'object' &&
      '_tag' in durableCause &&
      durableCause._tag === 'CanonicalizationFailed' &&
      'cause' in durableCause
    ) {
      expect(durableCause.cause).toEqual({
        _tag: 'CanonicalJsonFailure',
        path: '$.persistence.runId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      })
    }
    expect(durableError.message).toBe(
      `durable evidence verification failed: canonicalization of EXPECTED_DURABLE_EVIDENCE for run ${evidence.evaluation.runId} failed: invalid-unicode-surrogate at $.persistence.runId (string)`,
    )
  })

  test('derives immutable runtime transitions and exact log decisions from probe data', () => {
    const current = readyState()
    const original = structuredClone(current)
    const checkedAt = '2026-07-20T00:04:00.000Z'
    const pending = pendingCycle('2026-07-20T00:03:30.000Z')
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Unavailable', error: 'Signal identity mismatch' },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: {
          _tag: 'Available',
          value: {
            ...emptyCycleProjection(),
            current: pending,
            unfinishedCycleCount: 1,
          },
        },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    })

    expect(current).toEqual(original)
    expect(transition).toMatchObject({
      current,
      next: {
        status: 'DEGRADED',
        error: 'signal: Signal identity mismatch',
        health: { sequence: 2 },
        cycle: {
          condition: CycleOperationsCondition.Running,
          reason: CycleOperationsReason.AwaitingActivation,
          attemptAgeMs: 30_000,
        },
      },
      failedDependencies: ['signal'],
      checkedAt,
      clockFailure: null,
    })
    expect(deriveHealthLogDecisions(transition)).toEqual([
      {
        _tag: 'RuntimeStatusChanged',
        level: 'WARNING',
        message: 'Bayn health changed to DEGRADED',
        annotations: {
          service: 'bayn',
          checkedAt,
          probeSequence: 2,
          failedDependencies: 'signal',
        },
      },
      {
        _tag: 'CycleOperationsChanged',
        level: 'INFO',
        message: 'Bayn cycle operations changed to RUNNING',
        annotations: {
          service: 'bayn',
          checkedAt,
          cycleCondition: CycleOperationsCondition.Running,
          cycleReason: CycleOperationsReason.AwaitingActivation,
          currentCycleId: pending.cycleId,
          currentPhase: CycleState.Pending,
          signalSessionDate: pending.signalSessionDate,
          submissionCutoffAt: pending.submissionCutoffAt,
          attemptAgeMs: 30_000,
          unfinishedCycleCount: 1,
          unresolvedMutationCount: 0,
          zeroMutation: true,
        },
      },
    ])
  })

  test('projects live-capital mutation health through the durable capital stage', () => {
    const checkedAt = '2026-07-20T00:04:00.000Z'
    const liveIdentity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Live,
        accountId: brokerAccountId,
      }),
    )
    const liveConfig = {
      ...config,
      execution: {
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: {
          _tag: CapitalAuthorityKind.Granted,
          persistedGrantHash: 'b'.repeat(64),
          authorityGenerationHash: 'c'.repeat(64),
        },
      },
    } as typeof config
    const current = {
      ...readyState(),
      capitalActivation: {
        _tag: 'Realized' as const,
        requestHash: 'a'.repeat(64),
        generationHash: 'c'.repeat(64),
        grant: 'Qualified' as const,
        cutoffAt: '2026-07-20T00:30:00.000Z',
        expiresAt: '2026-07-22T20:00:00.000Z',
        maximumCloseSessions: null,
      },
      autonomousCycleLoop: {
        configured: true,
        startedAt: checkedAt,
        lastPass: { result: 'SUCCESS' as const, observedAt: checkedAt, outcome: 'NO_PUBLICATION' as const },
      },
    }
    const transition = deriveHealthTransition(current, {
      config: liveConfig,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: {
          _tag: 'Available',
          value: {
            ...emptyCycleProjection(),
            authority: {
              generationHash: 'c'.repeat(64),
              maximum: Authority.Execution,
              effective: Authority.Execution,
              kill: KillState.Clear,
              reason: null,
              updatedAt: checkedAt,
            },
            reconciliation: {
              accountId: brokerAccountId,
              reconciliationId: 'd'.repeat(64),
              status: ReconciliationStatus.Exact,
              discrepancyCount: 0,
              reconciledAt: checkedAt,
              coversLatestMutation: true,
            },
          },
        },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'Running' },
      clock: availableClock(checkedAt),
    })

    expect(transition.next.status).toBe('READY')
    expect(transition.next.cycle.reason).not.toBe(CycleOperationsReason.AuthorityMaximumMismatch)
    expect(transition.next.cycle.alerts.authorityIncoherent).toBe(false)
  })

  test('projects a realized research capital episode through its read-only bootstrap config', () => {
    const checkedAt = '2026-08-05T12:00:00.000Z'
    const current: RuntimeState = {
      ...readyState(),
      capitalActivation: {
        _tag: 'Realized',
        requestHash: 'a'.repeat(64),
        generationHash: 'b'.repeat(64),
        grant: 'Research',
        cutoffAt: '2026-09-01T13:30:00.000Z',
        expiresAt: '2026-09-03T20:00:00.000Z',
        maximumCloseSessions: 3,
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: {
          _tag: 'Available',
          value: {
            ...emptyCycleProjection(),
            authority: {
              generationHash: 'b'.repeat(64),
              maximum: Authority.Execution,
              effective: Authority.Execution,
              kill: KillState.Clear,
              reason: null,
              updatedAt: checkedAt,
            },
            reconciliation: {
              accountId: brokerAccountId,
              reconciliationId: 'c'.repeat(64),
              status: ReconciliationStatus.Exact,
              discrepancyCount: 0,
              reconciledAt: checkedAt,
              coversLatestMutation: true,
            },
          },
        },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    })

    expect(transition.next.cycle.reason).not.toBe(CycleOperationsReason.AuthorityMaximumMismatch)
    expect(transition.next.cycle.alerts.authorityIncoherent).toBe(false)
  })

  test('projects a completed execution episode against returned OBSERVE authority', () => {
    const checkedAt = '2026-08-12T16:00:00.000Z'
    const generationHash = 'b'.repeat(64)
    const current: RuntimeState = {
      ...readyState(),
      capitalActivation: {
        _tag: 'Completed',
        requestHash: 'a'.repeat(64),
        generationHash,
        grant: 'Qualified',
        receiptHash: 'c'.repeat(64),
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: {
          _tag: 'Available',
          value: {
            ...emptyCycleProjection(),
            authority: {
              generationHash: 'd'.repeat(64),
              maximum: Authority.Observe,
              effective: Authority.Observe,
              kill: KillState.Clear,
              reason: null,
              updatedAt: checkedAt,
            },
          },
        },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    })

    expect(transition.next.status).toBe('READY')
    expect(transition.next.cycle.reason).not.toBe(CycleOperationsReason.AuthorityMaximumMismatch)
    expect(transition.next.cycle.reason).not.toBe(CycleOperationsReason.KillActive)
    expect(transition.next.cycle.alerts.authorityIncoherent).toBe(false)
    expect(transition.next.cycle.alerts.killActive).toBe(false)
  })

  test('recovers readiness after an exact stale research bootstrap wait and preserves immutable failure evidence', () => {
    const checkedAt = '2026-08-11T17:30:00.000Z'
    const terminalAt = '2026-08-11T17:12:00.000Z'
    const generationHash = 'b'.repeat(64)
    const current: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt: terminalAt,
        lastPass: {
          result: 'SUCCESS',
          observedAt: checkedAt,
          outcome: 'NOT_DUE',
          notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
          cadenceDecision: decideMonthEndCadenceEligibility({
            signalSessionDate: '2026-08-10',
            executionSessionDate: '2026-08-11',
          }),
        },
      },
      capitalActivation: {
        _tag: 'Realized',
        requestHash: 'a'.repeat(64),
        generationHash,
        grant: 'Research',
        cutoffAt: '2026-09-01T13:30:00.000Z',
        expiresAt: '2026-09-03T20:00:00.000Z',
        maximumCloseSessions: 3,
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: {
          _tag: 'Available',
          value: {
            ...emptyCycleProjection(),
            last: {
              ...pendingCycle(terminalAt),
              signalSessionDate: '2026-08-10',
              executionSessionDate: '2026-08-11',
              phase: CycleState.Blocked,
              snapshotId: null,
              terminalReason: CycleTerminalReason.MissedPublication,
              terminalAt,
            },
            authority: {
              generationHash,
              maximum: Authority.Execution,
              effective: Authority.Execution,
              kill: KillState.Clear,
              reason: null,
              updatedAt: checkedAt,
            },
            reconciliation: {
              accountId: brokerAccountId,
              reconciliationId: 'c'.repeat(64),
              status: ReconciliationStatus.Exact,
              discrepancyCount: 0,
              reconciledAt: checkedAt,
              coversLatestMutation: true,
            },
          },
        },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'Running' },
      clock: availableClock(checkedAt),
    })

    expect(transition).toMatchObject({
      next: {
        status: 'READY',
        cycle: {
          condition: CycleOperationsCondition.Waiting,
          reason: CycleOperationsReason.StaleExecutionBootstrapSkipped,
          last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.MissedPublication },
          alerts: { cycleFailed: false, reconciliationBlocked: false },
        },
      },
      failedDependencies: [],
    })
  })

  test('observes a research cycle binding when startup evidence is unavailable', async () => {
    const researchPlanHash = 'b'.repeat(64)
    const checkedAt = '2026-07-20T00:00:00.000Z'
    const generationHash = 'd'.repeat(64)
    const initial: RuntimeState = {
      ...initialState({}),
      capitalActivation: {
        _tag: 'Realized',
        requestHash: 'c'.repeat(64),
        generationHash,
        grant: 'Research',
        cutoffAt: '2026-09-01T20:00:00.000Z',
        expiresAt: '2026-09-03T20:00:00.000Z',
        maximumCloseSessions: 3,
      },
    }
    const observedBindings: string[] = []
    const projection: CycleOperationsProjection = {
      ...emptyCycleProjection(),
      authority: {
        generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        reason: null,
        updatedAt: checkedAt,
      },
      reconciliation: {
        accountId: brokerAccountId,
        reconciliationId: 'e'.repeat(64),
        status: ReconciliationStatus.Exact,
        discrepancyCount: 0,
        reconciledAt: checkedAt,
        coversLatestMutation: true,
      },
    }
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(checkedAt))
      const state = yield* Ref.make(initial)
      yield* probe(config, state, undefined, undefined, researchPlanHash, false).pipe(
        Effect.provideService(MarketData, {
          check: Effect.succeed(makeSnapshot().manifest.finalizedSnapshot),
          inspect: Effect.die(new Error('health probes must not inspect sessions')),
          inspectCyclePublications: Effect.die(
            new Error('health probes must not inspect cycle publication candidates'),
          ),
          inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
          inspectSnapshotPublication: () =>
            Effect.die(new Error('health probes must not inspect bound cycle publications')),
          loadSnapshotPublication: () => Effect.die(new Error('health probes must not load bound cycle bars')),
          load: Effect.die(new Error('health probes must not load bars')),
        }),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, recoveringStore(readyState())),
        Effect.provideService(
          CycleObservability,
          cycleObservability((bindingId) =>
            Effect.sync(() => {
              observedBindings.push(bindingId)
              return projection
            }),
          ),
        ),
      )

      expect(observedBindings).toEqual([researchPlanHash])
      const observed = yield* Ref.get(state)
      expect(observed).toMatchObject({
        status: 'READY',
        health: {
          dependencies: {
            signal: { status: 'AVAILABLE', error: null },
            evidence: { status: 'AVAILABLE', error: null },
            cycle: { status: 'AVAILABLE', error: null },
          },
        },
        cycle: { condition: CycleOperationsCondition.Waiting, unfinishedCycleCount: 0 },
      })
      expect(isReady(observed)).toBe(true)
    }).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('does not manufacture a cycle-runner stall from a rejected finite clock', () => {
    const progressAt = '2026-07-20T00:00:00.000Z'
    const current: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt: progressAt,
        lastPass: { result: 'SUCCESS', observedAt: progressAt, outcome: 'NO_PUBLICATION' },
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'Running' },
      clock: unsafeClock(8_640_000_000_000_001),
    })

    expect(transition).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: 'cycle clock: cycle operations clock is outside the supported UTC range: observed=8640000000000001',
        health: {
          checkedAt: null,
          dependencies: {
            cycleRunner: {
              status: 'AVAILABLE',
              checkedAt: '2026-07-20T00:00:00.000Z',
              error: null,
            },
          },
        },
        cycle: {
          condition: CycleOperationsCondition.Unknown,
          reason: CycleOperationsReason.ObservationUnavailable,
          checkedAt: null,
          error: 'cycle operations clock is outside the supported UTC range: observed=8640000000000001',
        },
      },
      failedDependencies: ['cycle'],
      checkedAt: null,
      clockFailure: {
        _tag: 'UtcEpochMillisOutOfRange',
        epochMillis: 8_640_000_000_000_001,
      },
    })
  })

  test('keeps Restate-owned lifecycle unavailable until its first durable controller projection', () => {
    const controllerKey = 'f'.repeat(64)
    const current: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        owner: 'Restate',
        startedAt: null,
        lastPass: null,
      },
      executionController: {
        configured: true,
        controllerKey,
        planHash: controllerPlanHash,
        status: null,
        readAvailable: null,
        checkedAt: null,
        error: null,
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
        executionController: { _tag: 'Available', value: null },
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock('2026-07-20T00:00:01.000Z'),
    })

    expect(transition.next).toMatchObject({
      status: 'DEGRADED',
      health: {
        dependencies: {
          cycleRunner: {
            status: 'UNAVAILABLE',
            error: 'Restate lifecycle has not completed its first durable pass',
          },
        },
      },
      error: 'cycleRunner: Restate lifecycle has not completed its first durable pass',
    })
  })

  test('accepts a fresh Restate controller projection without a local lifecycle fiber', () => {
    const controllerKey = 'f'.repeat(64)
    const completedAt = '2026-07-20T00:00:00.000Z'
    const nextDueAt = '2026-07-20T00:01:00.000Z'
    const current: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: { configured: true, owner: 'Restate', startedAt: null, lastPass: null },
      executionController: {
        configured: true,
        controllerKey,
        planHash: controllerPlanHash,
        status: null,
        readAvailable: null,
        checkedAt: null,
        error: null,
      },
    }
    const status = {
      schemaVersion: 1 as const,
      controllerKey,
      planHash: controllerPlanHash,
      active: true,
      epoch: 4,
      lastSequence: 12,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: 'e'.repeat(64),
      completedAt,
      nextDueAt,
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
        executionController: { _tag: 'Available', value: status },
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock('2026-07-20T00:05:59.999Z'),
    })

    expect(transition.next).toMatchObject({
      status: 'READY',
      health: { dependencies: { cycleRunner: { status: 'AVAILABLE', error: null } } },
      executionController: { readAvailable: true, status },
    })

    const inactive = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
        executionController: { _tag: 'Available', value: { ...status, active: false } },
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock('2026-07-20T00:05:59.999Z'),
    })
    expect(inactive.next).toMatchObject({
      status: 'DEGRADED',
      health: {
        dependencies: {
          cycleRunner: { status: 'UNAVAILABLE', error: 'Restate execution controller is durably inactive' },
        },
      },
    })

    const stalePlan = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
        executionController: { _tag: 'Available', value: { ...status, planHash: 'c'.repeat(64) } },
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock('2026-07-20T00:05:59.999Z'),
    })
    expect(stalePlan.next).toMatchObject({
      status: 'DEGRADED',
      health: {
        dependencies: {
          cycleRunner: {
            status: 'UNAVAILABLE',
            error: 'Restate execution-controller projection plan differs from the configured controller',
          },
        },
      },
    })
  })

  test('fails closed when the Restate controller projection exceeds its due-time grace', () => {
    const controllerKey = 'f'.repeat(64)
    const current: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: { configured: true, owner: 'Restate', startedAt: null, lastPass: null },
      executionController: {
        configured: true,
        controllerKey,
        planHash: controllerPlanHash,
        status: null,
        readAvailable: null,
        checkedAt: null,
        error: null,
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
        executionController: {
          _tag: 'Available',
          value: {
            schemaVersion: 1,
            controllerKey,
            planHash: controllerPlanHash,
            active: true,
            epoch: 4,
            lastSequence: 12,
            lastOutcome: ExecutionControllerOutcome.Blocked,
            lastReceiptHash: 'e'.repeat(64),
            completedAt: '2026-07-20T00:00:00.000Z',
            nextDueAt: '2026-07-20T00:01:00.000Z',
          },
        },
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock('2026-07-20T00:06:00.000Z'),
    })

    expect(transition.next).toMatchObject({
      status: 'DEGRADED',
      health: {
        dependencies: {
          cycleRunner: { status: 'UNAVAILABLE', error: 'Restate execution controller is overdue by 300000ms' },
        },
      },
      error: 'cycleRunner: Restate execution controller is overdue by 300000ms',
    })
  })

  test('preserves the prior validated cycle-runner failure when the clock is unavailable', () => {
    const progressAt = '2026-07-20T00:00:00.000Z'
    const previousRunner = {
      status: 'UNAVAILABLE' as const,
      checkedAt: '2026-07-20T00:06:00.000Z',
      error: 'autonomous cycle loop has not completed a successful pass for 360000ms',
    }
    const ready = readyState()
    const current: RuntimeState = {
      ...ready,
      health: {
        ...ready.health,
        dependencies: { ...ready.health.dependencies, cycleRunner: previousRunner },
      },
      autonomousCycleLoop: {
        configured: true,
        startedAt: progressAt,
        lastPass: { result: 'SUCCESS', observedAt: progressAt, outcome: 'NO_PUBLICATION' },
      },
    }
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'Running' },
      clock: unsafeClock(8_640_000_000_000_001),
    })

    expect(transition).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: `${`cycleRunner: ${previousRunner.error}`}; cycle clock: cycle operations clock is outside the supported UTC range: observed=8640000000000001`,
        health: { dependencies: { cycleRunner: previousRunner } },
      },
      failedDependencies: ['cycleRunner', 'cycle'],
      clockFailure: {
        _tag: 'UtcEpochMillisOutOfRange',
        epochMillis: 8_640_000_000_000_001,
      },
    })
  })

  test('degrades with a closed cycle-classification failure instead of defecting', () => {
    const current = readyState()
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: unsafeClock(Number.NaN),
    })

    expect(transition).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: 'cycle clock: cycle operations clock must be a safe integer epoch millisecond: observed=NaN',
        cycle: {
          condition: CycleOperationsCondition.Unknown,
          reason: CycleOperationsReason.ObservationUnavailable,
          checkedAt: null,
          error: 'cycle operations clock must be a safe integer epoch millisecond: observed=NaN',
        },
        health: { checkedAt: null },
      },
      failedDependencies: ['cycle'],
      checkedAt: null,
      clockFailure: { _tag: 'UtcEpochMillisNotSafeInteger', epochMillis: Number.NaN },
    })
    const logDecisions = deriveHealthLogDecisions(transition)
    expect(logDecisions).toMatchObject([
      {
        _tag: 'RuntimeStatusChanged',
        level: 'WARNING',
        message: 'Bayn health changed to DEGRADED',
        annotations: {
          service: 'bayn',
          probeSequence: 2,
          failedDependencies: 'cycle',
        },
      },
      {
        _tag: 'CycleOperationsChanged',
        level: 'INFO',
        message: 'Bayn cycle operations changed to UNKNOWN',
        annotations: {
          service: 'bayn',
          cycleCondition: CycleOperationsCondition.Unknown,
          cycleReason: CycleOperationsReason.ObservationUnavailable,
        },
      },
    ])
    expect(logDecisions.every((decision) => !('checkedAt' in decision.annotations))).toBe(true)
  })

  test('reports an unavailable cycle dependency once', () => {
    const current = readyState()
    const checkedAt = '2026-07-20T00:04:00.000Z'
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Unavailable', error: 'cycle projection timed out' },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    })

    expect(transition).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: 'cycle: cycle projection timed out',
        cycle: {
          condition: CycleOperationsCondition.Unknown,
          reason: CycleOperationsReason.ObservationUnavailable,
          checkedAt,
          error: 'cycle projection timed out',
        },
      },
      failedDependencies: ['cycle'],
    })
  })

  test('keeps readiness available when a current active cycle succeeds a blocked terminal cycle', () => {
    const previous = pendingCycle('2026-07-20T11:00:00.000Z')
    const current = pendingCycle('2026-07-21T11:00:00.000Z')
    const transition = deriveHealthTransition(readyState(), {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: {
          _tag: 'Available',
          value: {
            ...emptyCycleProjection(),
            current: {
              ...current,
              cycleId: '4'.repeat(64),
              signalSessionDate: '2026-07-20',
              executionSessionDate: '2026-07-21',
              phase: CycleState.Active,
              submissionOpenAt: '2026-07-21T12:45:00.000Z',
              submissionCutoffAt: '2026-07-21T13:15:00.000Z',
              executionOpenAt: '2026-07-21T13:30:00.000Z',
              executionCloseAt: '2026-07-21T20:00:00.000Z',
            },
            last: {
              ...previous,
              phase: CycleState.Blocked,
              snapshotId: null,
              terminalReason: CycleTerminalReason.MissedPublication,
              terminalAt: '2026-07-20T12:00:00.000Z',
            },
            unfinishedCycleCount: 1,
          },
        },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock('2026-07-21T14:00:00.000Z'),
    })

    expect(transition).toMatchObject({
      next: {
        status: 'READY',
        cycle: {
          current: { phase: CycleState.Active, cycleId: '4'.repeat(64) },
          last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.MissedPublication },
          condition: CycleOperationsCondition.Running,
          reason: CycleOperationsReason.Active,
          alerts: { cycleFailed: false, cycleStalled: false },
        },
      },
      failedDependencies: [],
    })
  })

  test('redacts cycle account identity drift from runtime health, status, and logs', () => {
    const current = readyState()
    const checkedAt = '2026-07-20T00:04:00.000Z'
    const accountId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const rawError =
      `PostgreSQL cycle-observability failed: configured account ${accountId} ` +
      'differs from the projected current or last cycle'
    const publicError = 'configured account binding differs from the projected current or last cycle'
    const transition = deriveHealthTransition(current, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Unavailable', error: rawError },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    })
    const logDecisions = deriveHealthLogDecisions(transition)

    expect(transition).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: `cycle: ${publicError}`,
        health: {
          dependencies: {
            cycle: {
              status: 'UNAVAILABLE',
              checkedAt,
              error: publicError,
            },
          },
        },
        cycle: {
          condition: CycleOperationsCondition.Unknown,
          reason: CycleOperationsReason.ObservationUnavailable,
          checkedAt,
          error: publicError,
        },
      },
      failedDependencies: ['cycle'],
    })
    expect(logDecisions).toMatchObject([
      {
        _tag: 'RuntimeStatusChanged',
        annotations: { failedDependencies: 'cycle' },
      },
      {
        _tag: 'CycleOperationsChanged',
        annotations: { cycleError: publicError },
      },
    ])
    const publicStatus = statusFacts(transition.next, config.execution, provenance, 'embedded')
    expect(publicStatus.dependencies.cycle.error).toBe('CYCLE_ACCOUNT_IDENTITY_MISMATCH')
    expect(publicStatus.cycle.error).toBe('CYCLE_ACCOUNT_IDENTITY_MISMATCH')
    expect(JSON.stringify({ transition, logDecisions })).not.toContain(accountId)
    expect(JSON.stringify({ transition, logDecisions })).not.toContain(rawError)
  })

  test('retains clock failure alongside an unavailable cycle projection and logs clock recovery', () => {
    const projectionError = 'cycle projection timed out'
    const clockError = 'cycle operations clock must be a safe integer epoch millisecond: observed=NaN'
    const failed = deriveHealthTransition(readyState(), {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Unavailable', error: projectionError },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: unsafeClock(Number.NaN),
    })

    expect(failed).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: `cycle: ${projectionError}; cycle clock: ${clockError}`,
        cycle: {
          condition: CycleOperationsCondition.Unknown,
          reason: CycleOperationsReason.ObservationUnavailable,
          checkedAt: null,
          error: `${projectionError}; ${clockError}`,
        },
      },
      failedDependencies: ['cycle'],
      checkedAt: null,
      clockFailure: { _tag: 'UtcEpochMillisNotSafeInteger', epochMillis: Number.NaN },
    })

    const checkedAt = '2026-07-20T00:04:00.000Z'
    const recoveredClock = deriveHealthTransition(failed.next, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Unavailable', error: projectionError },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    })

    expect(recoveredClock).toMatchObject({
      next: {
        status: 'DEGRADED',
        error: `cycle: ${projectionError}`,
        cycle: {
          condition: CycleOperationsCondition.Unknown,
          reason: CycleOperationsReason.ObservationUnavailable,
          checkedAt,
          error: projectionError,
        },
      },
      failedDependencies: ['cycle'],
      checkedAt,
      clockFailure: null,
    })
    expect(deriveHealthLogDecisions(recoveredClock)).toMatchObject([
      {
        _tag: 'CycleOperationsChanged',
        level: 'INFO',
        message: 'Bayn cycle operations changed to UNKNOWN',
        annotations: {
          service: 'bayn',
          checkedAt,
          cycleCondition: CycleOperationsCondition.Unknown,
          cycleReason: CycleOperationsReason.ObservationUnavailable,
          cycleError: projectionError,
        },
      },
    ])
  })

  test('logs a changed UNKNOWN cycle failure without fabricating its time', () => {
    const checkedAt = '2026-07-20T00:04:00.000Z'
    const unavailable = deriveHealthTransition(readyState(), {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Unavailable', error: 'cycle projection timed out' },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: availableClock(checkedAt),
    }).next
    const invalidClock = deriveHealthTransition(unavailable, {
      config,
      evidenceAvailable: true,
      results: {
        postgresql: { _tag: 'Available', value: undefined },
        signal: { _tag: 'Available', value: undefined },
        tigerBeetle: { _tag: 'Available', value: undefined },
        durableEvidence: { _tag: 'Available', value: undefined },
        cycle: { _tag: 'Available', value: emptyCycleProjection() },
        broker: null,
      },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: unsafeClock(Number.NaN),
    })

    expect(deriveHealthLogDecisions(invalidClock)).toMatchObject([
      {
        _tag: 'CycleOperationsChanged',
        level: 'INFO',
        message: 'Bayn cycle operations changed to UNKNOWN',
        annotations: {
          service: 'bayn',
          cycleCondition: CycleOperationsCondition.Unknown,
          cycleReason: CycleOperationsReason.ObservationUnavailable,
          cycleError: 'cycle operations clock must be a safe integer epoch millisecond: observed=NaN',
        },
      },
    ])
    expect(deriveHealthLogDecisions(invalidClock).every((decision) => !('checkedAt' in decision.annotations))).toBe(
      true,
    )
  })

  test('keeps the repeating probe alive when the injected clock is invalid', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Number.NaN)
        yield* provideHealthyDependencies(initial, probe(config, state))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          error: 'cycle clock: cycle operations clock must be a safe integer epoch millisecond: observed=NaN',
          health: {
            checkedAt: null,
            dependencies: {
              postgresql: { checkedAt: null },
              signal: { checkedAt: null },
              tigerBeetle: { checkedAt: null },
              evidence: { checkedAt: null },
              cycle: { checkedAt: null },
              cycleRunner: { checkedAt: null },
            },
          },
          cycle: {
            condition: CycleOperationsCondition.Unknown,
            reason: CycleOperationsReason.ObservationUnavailable,
            checkedAt: null,
            error: 'cycle operations clock must be a safe integer epoch millisecond: observed=NaN',
          },
        })
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('verifies the bounded continuous broker-read surface and never calls broker mutations', async () => {
    const control = brokerReadControl()
    let mutationCalls = 0
    const brokerWithMutations = {
      ...brokerProbe(brokerRead(control)),
      submitOrder: () => {
        mutationCalls += 1
      },
      cancelOrder: () => {
        mutationCalls += 1
      },
    }
    const broker: BrokerProbe = brokerWithMutations
    const initial = brokerRuntimeState(broker, await Effect.runPromise(currentUtcInstant))
    const state = await Effect.runPromise(Ref.make(initial))
    const cycleFiber = Effect.runFork(Effect.never)

    try {
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'READY',
        broker: {
          configured: true,
          expectedAccountId: brokerAccountId,
          accountId: brokerAccountId,
          accountBound: true,
          readAvailable: true,
          executionEligible: false,
          executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
          error: null,
        },
        error: null,
      })
      expect([...control.reads].sort()).toEqual([...brokerHealthReadNames].sort())
      expect(control.orderQueries).toEqual([
        { status: OrderCollection.Open, limit: 1 },
        { status: OrderCollection.All, limit: 1, direction: SortDirection.Descending },
      ])
      expect(control.fillQueries).toEqual([{ pageSize: 1, direction: SortDirection.Descending }])
      expect(control.unexpectedReads).toEqual([])
      expect(mutationCalls).toBe(0)
    } finally {
      await Effect.runPromise(Fiber.interrupt(cycleFiber))
    }
  })

  test('degrades for every unavailable broker read and recovers on the next complete pass', async () => {
    const control = brokerReadControl()
    const broker = brokerProbe(brokerRead(control))
    const initial = brokerRuntimeState(broker, await Effect.runPromise(currentUtcInstant))
    const state = await Effect.runPromise(Ref.make(initial))
    const cycleFiber = Effect.runFork(Effect.never)
    try {
      for (const name of brokerHealthReadNames) {
        control.unavailable = name
        await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
        const expectedError = `Alpaca ${brokerHealthReadBehaviors[name]} unavailable: injected ${name} failure`
        expect(await Effect.runPromise(Ref.get(state)), name).toMatchObject({
          status: 'DEGRADED',
          broker: {
            accountId: null,
            accountBound: false,
            readAvailable: false,
            error: expectedError,
          },
          error: `broker: ${expectedError}`,
        })

        control.unavailable = null
        await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
        expect(await Effect.runPromise(Ref.get(state)), `${name} recovery`).toMatchObject({
          status: 'READY',
          broker: {
            accountId: brokerAccountId,
            accountBound: true,
            readAvailable: true,
            error: null,
          },
          error: null,
        })
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(cycleFiber))
    }
  })

  test('degrades on malformed broker data and recovers on the next complete pass', async () => {
    const control = brokerReadControl()
    const broker = brokerProbe(brokerRead(control))
    const initial = brokerRuntimeState(broker, await Effect.runPromise(currentUtcInstant))
    const state = await Effect.runPromise(Ref.make(initial))
    const cycleFiber = Effect.runFork(Effect.never)

    try {
      control.malformed = 'recent-orders'
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'DEGRADED',
        broker: {
          accountId: null,
          accountBound: false,
          readAvailable: false,
          error: 'Alpaca recent orders read unavailable: injected malformed recent-orders response',
        },
        error: 'broker: Alpaca recent orders read unavailable: injected malformed recent-orders response',
      })

      control.malformed = null
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'READY', error: null })
    } finally {
      await Effect.runPromise(Fiber.interrupt(cycleFiber))
    }
  })

  test('preserves identity mismatch precedence and recovers from every permission drift', async () => {
    const control = brokerReadControl()
    const broker = brokerProbe(brokerRead(control))
    const initial = brokerRuntimeState(broker, await Effect.runPromise(currentUtcInstant))
    const state = await Effect.runPromise(Ref.make(initial))
    const cycleFiber = Effect.runFork(Effect.never)

    const expectDriftAndRecovery = async (expectedError: string, restore: () => void) => {
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      const drifted = await Effect.runPromise(Ref.get(state))
      expect(drifted).toMatchObject({
        status: 'DEGRADED',
        broker: {
          accountId: brokerAccountId,
          accountBound: true,
          readAvailable: false,
          error: expectedError,
        },
        error: `broker: ${expectedError}`,
      })
      const readiness = readinessResponseDecision(drifted)
      expect(readiness).toMatchObject({ _tag: 'Json', status: 503 })
      if (readiness._tag !== 'Json') throw new Error('expected JSON readiness decision')
      const readinessBody = readiness.body as {
        readonly ready: boolean
        readonly failedDependencies: readonly string[]
      }
      expect(readinessBody.ready).toBe(false)
      expect(readinessBody.failedDependencies).toContain('broker')
      restore()
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'READY',
        broker: { accountId: brokerAccountId, accountBound: true, readAvailable: true, error: null },
        error: null,
      })
    }

    try {
      const observedAccountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      control.accountId = observedAccountId
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'DEGRADED',
        broker: {
          accountId: observedAccountId,
          accountBound: false,
          readAvailable: true,
          error: 'Alpaca account identity drift detected',
        },
        error: 'broker: Alpaca account identity drift detected',
      })

      control.accountId = brokerAccountId
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'READY',
        broker: {
          accountId: brokerAccountId,
          accountBound: true,
          readAvailable: true,
          error: null,
        },
        error: null,
      })

      control.accountId = observedAccountId
      control.tradingBlocked = true
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'DEGRADED',
        broker: {
          accountId: observedAccountId,
          accountBound: false,
          readAvailable: false,
          error: 'Alpaca account identity drift detected',
        },
        error: 'broker: Alpaca account identity drift detected',
      })

      control.accountId = brokerAccountId
      control.tradingBlocked = false
      await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))
      expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
        status: 'READY',
        broker: {
          accountId: brokerAccountId,
          accountBound: true,
          readAvailable: true,
          error: null,
        },
        error: null,
      })

      const permissionCases = [
        {
          expected: 'account status is DISABLED, expected ACTIVE',
          drift: () => {
            control.accountStatus = AccountStatus.Disabled
          },
          restore: () => {
            control.accountStatus = AccountStatus.Active
          },
        },
        {
          expected: 'account is blocked',
          drift: () => {
            control.accountBlocked = true
          },
          restore: () => {
            control.accountBlocked = false
          },
        },
        {
          expected: 'trading is blocked',
          drift: () => {
            control.tradingBlocked = true
          },
          restore: () => {
            control.tradingBlocked = false
          },
        },
        {
          expected: 'trading is suspended by the user',
          drift: () => {
            control.tradeSuspendedByUser = true
          },
          restore: () => {
            control.tradeSuspendedByUser = false
          },
        },
        {
          expected: 'fractional trading is disabled',
          drift: () => {
            control.fractionalTrading = false
          },
          restore: () => {
            control.fractionalTrading = true
          },
        },
      ] as const
      for (const testCase of permissionCases) {
        testCase.drift()
        await expectDriftAndRecovery(`Alpaca account permission drift detected: ${testCase.expected}`, testCase.restore)
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(cycleFiber))
    }
  })

  test('times out and interrupts every in-flight continuous broker read exactly once', async () => {
    const startedAt = '2026-07-20T00:00:00.000Z'
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(startedAt))
        const pending = yield* makePendingBrokerRead()
        const broker = brokerProbe(pending.read)
        const initial = brokerRuntimeState(broker, startedAt)
        const state = yield* Ref.make(initial)
        const cycleFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true }))
        const healthFiber = yield* provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* Deferred.await(pending.allStarted)
        yield* TestClock.adjust(config.operationTimeoutMs - 1)
        expect(Object.values(pending.finalizations).every((count) => count === 0)).toBe(true)
        yield* TestClock.adjust(1)
        yield* Fiber.join(healthFiber)

        expect(pending.finalizations).toEqual({
          account: 1,
          'account-configuration': 1,
          positions: 1,
          'open-orders': 1,
          'recent-orders': 1,
          'recent-fills': 1,
        })
        const timeoutError = brokerHealthReadNames
          .map((name) => `Alpaca ${brokerHealthReadBehaviors[name]} timed out after ${config.operationTimeoutMs}ms`)
          .join('; ')
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          broker: {
            accountId: null,
            accountBound: false,
            readAvailable: false,
            error: timeoutError,
          },
          error: `broker: ${timeoutError}`,
        })
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('interrupts every in-flight broker read without publishing a partial health pass', async () => {
    const pending = await Effect.runPromise(makePendingBrokerRead())
    const broker = brokerProbe(pending.read)
    const initial = brokerRuntimeState(broker, await Effect.runPromise(currentUtcInstant))
    const state = await Effect.runPromise(Ref.make(initial))
    const cycleFiber = Effect.runFork(Effect.never)
    const healthFiber = Effect.runFork(provideHealthyDependencies(initial, probe(config, state, broker, cycleFiber)))

    try {
      await Effect.runPromise(Deferred.await(pending.allStarted))
      await Effect.runPromise(Fiber.interrupt(healthFiber))
      expect(pending.finalizations).toEqual({
        account: 1,
        'account-configuration': 1,
        positions: 1,
        'open-orders': 1,
        'recent-orders': 1,
        'recent-fills': 1,
      })
      expect(await Effect.runPromise(Ref.get(state))).toEqual(initial)
    } finally {
      await Effect.runPromise(Fiber.interrupt(cycleFiber))
    }
  })

  test('degrades when Alpaca is configured without the autonomous cycle runner', async () => {
    const broker = brokerProbe(brokerRead(brokerReadControl()))
    const initial: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: false,
        startedAt: null,
        lastPass: null,
      },
      broker: initialState({ broker }).broker,
    }
    const state = await Effect.runPromise(Ref.make(initial))

    await Effect.runPromise(provideHealthyDependencies(initial, probe(config, state, broker)))

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      health: {
        dependencies: {
          cycleRunner: {
            status: 'UNAVAILABLE',
            error: 'broker-configured Bayn runtime has no autonomous cycle loop',
          },
        },
      },
      error: expect.stringContaining('cycleRunner: broker-configured Bayn runtime has no autonomous cycle loop'),
    })
  })

  test('degrades on a probe defect, preserves evidence, and recovers only after a complete success', async () => {
    const initial = readyState()
    const initialEvidence = initial.evidence
    if (initialEvidence === null) throw new Error('ready fixture must contain evidence')
    const state = await Effect.runPromise(Ref.make(initial))
    let signalAvailable = false
    let databaseAvailable = true
    let accountingChecks = 0
    const marketData: MarketDataService = {
      check: Effect.suspend(() =>
        signalAvailable
          ? Effect.succeed(makeSnapshot().manifest.finalizedSnapshot)
          : Effect.die(new Error('Signal connection defect')),
      ),
      inspect: Effect.die(new Error('health probes must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health probes must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health probes must not inspect bound cycle publications')),
      loadSnapshotPublication: () => Effect.die(new Error('health probes must not load bound cycle bars')),
      load: Effect.die(new Error('health probes must not load bars')),
    }
    const journal: JournalService = {
      post: () => Effect.die(new Error('health probes must not write TigerBeetle')),
      verifyAccount: () => Effect.die(new Error('health probes must not reconcile execution accounting')),
      check: Effect.die(new Error('a durable run must use checkRun')),
      checkRun: () => Effect.sync(() => void (accountingChecks += 1)),
      journalAndReconcile: () => Effect.die(new Error('health probes must not write TigerBeetle')),
    }
    const evidenceStore = {
      ...recoveringStore(initial),
      check: Effect.suspend(() =>
        databaseAvailable
          ? Effect.void
          : Effect.fail(
              new DatabaseError({
                failure: 'unavailable',
                operation: 'check',
                message: 'database unavailable',
              }),
            ),
      ),
    }
    const dependencies = (
      effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability>,
    ) =>
      effect.pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, evidenceStore),
        Effect.provideService(CycleObservability, cycleObservability()),
      )

    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      evidence: { evaluation: { runId: initialEvidence.evaluation.runId } },
      health: {
        sequence: 2,
        dependencies: {
          postgresql: { status: 'AVAILABLE' },
          signal: { status: 'UNAVAILABLE', error: 'Signal connection defect' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })

    signalAvailable = true
    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'READY',
      error: null,
      health: {
        sequence: 3,
        dependencies: {
          postgresql: { status: 'AVAILABLE' },
          signal: { status: 'AVAILABLE' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })

    databaseAvailable = false
    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      health: {
        sequence: 4,
        dependencies: {
          postgresql: { status: 'UNAVAILABLE', error: expect.stringContaining('database unavailable') },
          signal: { status: 'AVAILABLE' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })
    expect(accountingChecks).toBe(3)
  })

  test('runs immediately and then on the configured Effect schedule', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    let checks = 0
    const marketData: MarketDataService = {
      check: Effect.sync(() => {
        checks += 1
        return makeSnapshot().manifest.finalizedSnapshot
      }),
      inspect: Effect.die(new Error('health monitor must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health monitor must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health monitor must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health monitor must not inspect bound cycle publications')),
      loadSnapshotPublication: () => Effect.die(new Error('health monitor must not load bound cycle bars')),
      load: Effect.die(new Error('health monitor must not load bars')),
    }
    const journal: JournalService = { ...successfulJournal, checkRun: () => Effect.void }
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* monitor({ ...config, healthIntervalMs: 100 }, state).pipe(
          Effect.provideService(MarketData, marketData),
          Effect.provideService(Journal, journal),
          Effect.provideService(EvidenceStore, recoveringStore(initial)),
          Effect.provideService(CycleObservability, cycleObservability()),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        expect(checks).toBe(1)
        yield* TestClock.adjust(99)
        expect(checks).toBe(1)
        yield* TestClock.adjust(1)
        expect(checks).toBe(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('interrupts an in-flight probe when its scope closes', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    const started = await Effect.runPromise(Deferred.make<void>())
    let interrupted = false
    const marketData: MarketDataService = {
      check: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
      ),
      inspect: Effect.die(new Error('health monitor must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health monitor must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health monitor must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health monitor must not inspect bound cycle publications')),
      loadSnapshotPublication: () => Effect.die(new Error('health monitor must not load bound cycle bars')),
      load: Effect.die(new Error('health monitor must not load bars')),
    }
    const fiber = Effect.runFork(
      monitor(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
        Effect.provideService(CycleObservability, cycleObservability()),
      ),
    )
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(interrupted).toBe(true)
  })

  test('degrades on the latest cycle pass failure and requires a later success before the stall boundary', async () => {
    const startedAt = '2026-07-20T00:00:00.000Z'
    const initial: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt,
        lastPass: {
          result: 'FAILURE',
          observedAt: '2026-07-20T00:00:59.000Z',
          operation: 'market-calendar',
          failure: 'calendar-read',
          message: 'authoritative calendar unavailable',
        },
      },
    }
    const state = await Effect.runPromise(Ref.make(initial))
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-07-20T00:01:00.000Z'))
        const cycleFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true }))

        yield* provideHealthyDependencies(initial, probe(config, state, undefined, cycleFiber))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          health: {
            dependencies: {
              cycleRunner: {
                status: 'UNAVAILABLE',
                error: 'market-calendar/calendar-read: authoritative calendar unavailable',
              },
            },
          },
          error: expect.stringContaining(
            'cycleRunner: market-calendar/calendar-read: authoritative calendar unavailable',
          ),
        })

        yield* Ref.update(
          state,
          (current): RuntimeState => ({
            ...current,
            autonomousCycleLoop: {
              ...current.autonomousCycleLoop,
              lastPass: {
                result: 'SUCCESS',
                observedAt: '2026-07-20T00:01:00.000Z',
                outcome: 'NO_PUBLICATION',
              },
            },
          }),
        )
        yield* provideHealthyDependencies(initial, probe(config, state, undefined, cycleFiber))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'READY',
          health: { dependencies: { cycleRunner: { status: 'AVAILABLE', error: null } } },
          error: null,
        })

        yield* TestClock.adjust(config.cycleStallThresholdMs - 1)
        yield* provideHealthyDependencies(initial, probe(config, state, undefined, cycleFiber))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'READY',
          health: { dependencies: { cycleRunner: { status: 'AVAILABLE' } } },
        })

        yield* TestClock.adjust(1)
        yield* provideHealthyDependencies(initial, probe(config, state, undefined, cycleFiber))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          health: {
            dependencies: {
              cycleRunner: {
                status: 'UNAVAILABLE',
                error: `autonomous cycle loop has not completed a successful pass for ${config.cycleStallThresholdMs}ms`,
              },
            },
          },
        })

        yield* Ref.update(
          state,
          (current): RuntimeState => ({
            ...current,
            autonomousCycleLoop: {
              ...current.autonomousCycleLoop,
              lastPass: {
                result: 'SUCCESS',
                observedAt: '2026-07-20T00:06:00.000Z',
                outcome: 'NO_PUBLICATION',
              },
            },
          }),
        )
        yield* provideHealthyDependencies(initial, probe(config, state, undefined, cycleFiber))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'READY',
          health: { dependencies: { cycleRunner: { status: 'AVAILABLE', error: null } } },
          error: null,
        })
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('surfaces an unexpected autonomous cycle fiber exit through existing health', async () => {
    const initial: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt: '2026-07-20T00:00:00.000Z',
        lastPass: {
          result: 'SUCCESS',
          observedAt: '2026-07-20T00:00:00.000Z',
          outcome: 'NO_PUBLICATION',
        },
      },
    }
    const state = await Effect.runPromise(Ref.make(initial))
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-07-20T00:00:01.000Z'))
        const failedFiber = yield* Effect.die(new Error('injected autonomous cycle defect')).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        yield* provideHealthyDependencies(initial, probe(config, state, undefined, failedFiber))
        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          health: {
            dependencies: {
              cycleRunner: {
                status: 'UNAVAILABLE',
                error: expect.stringContaining('injected autonomous cycle defect'),
              },
            },
          },
        })
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('surfaces an interrupted autonomous cycle fiber as a runner failure', async () => {
    const initial: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt: '2026-07-20T00:00:00.000Z',
        lastPass: {
          result: 'SUCCESS',
          observedAt: '2026-07-20T00:00:00.000Z',
          outcome: 'NO_PUBLICATION',
        },
      },
    }
    const state = await Effect.runPromise(Ref.make(initial))
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-07-20T00:00:01.000Z'))
        const interruptedFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Fiber.interrupt(interruptedFiber)
        yield* provideHealthyDependencies(initial, probe(config, state, undefined, interruptedFiber))

        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          health: {
            dependencies: {
              cycleRunner: {
                status: 'UNAVAILABLE',
                error: 'autonomous cycle loop failed: All fibers interrupted without error',
              },
            },
          },
          error: 'cycleRunner: autonomous cycle loop failed: All fibers interrupted without error',
        })
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('does not erase a loop failure recorded while a health probe is in flight', async () => {
    const initial: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt: '2026-07-20T00:00:00.000Z',
        lastPass: {
          result: 'SUCCESS',
          observedAt: '2026-07-20T00:00:00.000Z',
          outcome: 'NO_PUBLICATION',
        },
      },
    }
    const state = await Effect.runPromise(Ref.make(initial))
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const marketData: MarketDataService = {
      check: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(makeSnapshot().manifest.finalizedSnapshot),
      ),
      inspect: Effect.die(new Error('health probes must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health probes must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health probes must not inspect bound cycle publications')),
      loadSnapshotPublication: () => Effect.die(new Error('health probes must not load bound cycle bars')),
      load: Effect.die(new Error('health probes must not load bars')),
    }
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-07-20T00:01:00.000Z'))
        const cycleFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true }))
        const healthFiber = yield* probe(config, state, undefined, cycleFiber).pipe(
          Effect.provideService(MarketData, marketData),
          Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
          Effect.provideService(EvidenceStore, recoveringStore(initial)),
          Effect.provideService(CycleObservability, cycleObservability()),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        yield* Ref.update(
          state,
          (current): RuntimeState => ({
            ...current,
            autonomousCycleLoop: {
              ...current.autonomousCycleLoop,
              lastPass: {
                result: 'FAILURE',
                observedAt: '2026-07-20T00:01:00.000Z',
                operation: 'market-calendar',
                failure: 'calendar-read',
                message: 'failure recorded during health I/O',
              },
            },
          }),
        )
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(healthFiber)

        expect(yield* Ref.get(state)).toMatchObject({
          status: 'DEGRADED',
          autonomousCycleLoop: {
            lastPass: {
              result: 'FAILURE',
              message: 'failure recorded during health I/O',
            },
          },
          health: {
            dependencies: {
              cycleRunner: {
                status: 'UNAVAILABLE',
                error: 'market-calendar/calendar-read: failure recorded during health I/O',
              },
            },
          },
        })
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('treats the stall threshold as exclusive and clears only after a later terminal success', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    const pending = pendingCycle('2026-07-20T00:00:00.000Z')
    let projection: CycleOperationsProjection = {
      ...emptyCycleProjection(),
      current: pending,
      unfinishedCycleCount: 1,
    }
    const dependencies = (
      effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability>,
    ) =>
      effect.pipe(
        Effect.provideService(MarketData, {
          check: Effect.succeed(makeSnapshot().manifest.finalizedSnapshot),
          inspect: Effect.die(new Error('health probes must not inspect sessions')),
          inspectCyclePublications: Effect.die(
            new Error('health probes must not inspect cycle publication candidates'),
          ),
          inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
          inspectSnapshotPublication: () =>
            Effect.die(new Error('health probes must not inspect bound cycle publications')),
          loadSnapshotPublication: () => Effect.die(new Error('health probes must not load bound cycle bars')),
          load: Effect.die(new Error('health probes must not load bars')),
        }),
        Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
        Effect.provideService(
          CycleObservability,
          cycleObservability(() => Effect.sync(() => projection)),
        ),
      )
    const thresholdConfig = { ...config, cycleStallThresholdMs: 300_000 }
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-07-20T00:04:59.999Z'))
      yield* dependencies(probe(thresholdConfig, state))
      expect(yield* Ref.get(state)).toMatchObject({
        status: 'READY',
        cycle: {
          condition: CycleOperationsCondition.Running,
          reason: CycleOperationsReason.AwaitingActivation,
          attemptAgeMs: 299_999,
          alerts: { cycleStalled: false, cycleFailed: false },
        },
      })

      yield* TestClock.adjust(1)
      yield* dependencies(probe(thresholdConfig, state))
      expect(yield* Ref.get(state)).toMatchObject({
        status: 'DEGRADED',
        cycle: {
          condition: CycleOperationsCondition.Stalled,
          reason: CycleOperationsReason.AttemptStale,
          attemptAgeMs: 300_000,
          alerts: { cycleStalled: true },
        },
      })

      projection = {
        ...emptyCycleProjection(),
        last: {
          ...pending,
          phase: CycleState.Completed,
          decisionHash: '3'.repeat(64),
          updatedAt: '2026-07-20T00:05:01.000Z',
          terminalAt: '2026-07-20T00:05:01.000Z',
        },
      }
      yield* TestClock.adjust(1_000)
      yield* dependencies(probe(thresholdConfig, state))
      expect(yield* Ref.get(state)).toMatchObject({
        status: 'READY',
        cycle: {
          condition: CycleOperationsCondition.Waiting,
          reason: CycleOperationsReason.LastCycleCompleted,
          alerts: { cycleStalled: false, cycleFailed: false },
        },
      })
    }).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })
})
