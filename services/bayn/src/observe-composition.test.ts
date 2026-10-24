import { makeIntradayMomentumDefinition } from './strategy/intraday-momentum/test-support'
import {
  decodeIntradayMomentumProtocol,
  defaultIntradayMomentumProtocolDocument,
} from './strategy/intraday-momentum/protocol'
import { strictParseOptions } from './schemas'
import { BrokerMutationError, MutationFailure } from './broker/alpaca-mutations/model'
import { advancePositionProtection } from './observe-composition/position-protection-interpreter'
import { withProviderSessions } from './testing/market-calendar-fixture'
import { equityMarketProfile } from './jev/markets'
import { CandidateObservationStore } from './observe-composition/candidate-observation'
import { streamingFixtureFromRaw, fixtureStreamingReference } from './testing/streaming-market-fixture'
import { describe, expect, spyOn, test } from 'bun:test'
import * as executionCycleModule from './observe-composition/execution-cycle'

import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Option, Result, Semaphore, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import type { AutonomousCycleLoop } from './app'
import type { AutonomousCyclePassObservation } from './runtime-state'
import { fixtureProtocol, fixtureRuntime } from './testing/runtime-fixtures'
import { JevBatchStore } from './jev/batch-evaluation'
import { JevEvaluationStore } from './jev/evaluation'
import { JevClient } from './jev/client'
import { buildObserveCycleDecision, loadExecutionRiskPolicy } from './observe-composition/decision-builder'
import { JevPositionStore } from './jev/portfolio'
import { nativeJevBatchResult, nativeJevDecisionEvidence } from './jev/native.test-support'
import { makeJevDefinition } from './jev/decision'
import { jevBehaviorHash } from './jev/protocol'
import type { CycleDecisionDocument } from './shadow-decision-contract'
import { CycleDecisionBuildError, CycleRunnerError } from './cycle/runner/model'
import { runAutonomousCyclePass } from './cycle/runner/program'
import type { ObserveDecisionRuntime } from './observe-composition/model'
import {
  makeRecoveryFirstCycleDriver,
  mutationDecisionBuilder,
  reconciliationForPreparation,
  runRestateAdvanceWithinTimeout,
} from './observe-composition/recovery-driver'
import { DecisionReadinessReason } from './cycle/runner/readiness'
import { boundedReconciliationPass, decisionBuildError } from './observe-composition/decision-builder'
import { runRecoveryFirstCyclePass } from './observe-composition/execution-cycle'
import { protectedAccountAdmission } from './observe-composition/account-admission'
import {
  AccountStatus as BrokerAccountStatus,
  BrokerRead,
  type Account as BrokerAccount,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type ReadEvidence,
  type ReadResult,
} from './broker/alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from './broker/alpaca/failures'
import { unusedAssetBySymbol } from './broker/alpaca-test-support'
import { MutationOperation } from './broker/alpaca-mutations/model'
import { orderRequestBody } from './broker/alpaca-mutations/decisions'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from './broker/identity'
import { CycleState, CycleTerminalReason, AutonomousCycleSchema } from './cycle/model'
import {
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from './cycle/construction'
import { makeStrategyProtocolHash } from './contracts.test-support'
import { CycleStore, CycleStoreError, type CycleStoreShape } from './cycle/store/model'
import { attachCycleDecisionStoreEvidence } from './cycle/store/decision-contract'
import { decideCompletion, validateCompletionDocument } from './cycle/store/decisions'
import type { ReconciliationWriteResult } from './db/reconciliation'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  ExecutionStoreError,
  AuthorityRestrictionStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type BrokerEventStoreShape,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type FillAccountingStoreShape,
  type ReconciliationStoreShape,
  type ValuationStoreShape,
} from './db/execution-store'
import { operationalError, retryableOperationalError, type OperationalError } from './errors'
import { BrokerAccess, makeExecutionAuthority, grantedCapitalAuthority } from './execution/authority'
import {
  IntentStore,
  planExecutionIntent,
  type IntentStoreService,
  type StoredIntent,
} from './execution/intents/domain'
import { type BlockedCycleIntentStoreShape } from './execution/intents/blocked-cycle'
import {
  MutationEventType,
  MutationStore,
  type MutationEvent,
  type MutationStoreShape,
} from './execution/mutations/model'
import type { ExecutionProgram } from './execution/runtime-program'
import { WriterFence, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1Result } from './hash'
import {
  IntradaySnapshotPurpose,
  type IntradayMarketDataService,
  type IntradaySnapshotRequest,
} from './market-data/intraday/model'

import { IntradayIngestionDelayDirection, IntradaySnapshotFailure } from './market-data/intraday/model'
import { marketDataOperationError } from './market-data/errors'
import { unusedEntryExpiresAt } from './cycle/entry-admission'
import { decideDecisionBinding } from './cycle/store/decisions'
import { constructStreamingSnapshot } from './market-data/streaming/snapshot'
import { intradayMomentumBehaviorHash } from './strategy/intraday-momentum/decision'
import { makeJevMarketTestSnapshot as makeIntradayMomentumTestSnapshot } from './testing/jev-market-fixture'
import {
  buildMutationShadowCycleDecision,
  prepareClosingExecutionCycleDecision,
  makeClosingDecisionPlan,
} from './observe-composition/decision-builder'
import {
  countOpenPositions,
  decidePendingMutationObservation,
  decideExecutionPhaseCompletion,
  decideExecutionIntentTerminalDisposition,
  decidePreparedMutationIntent,
  decidePreparedCloseIntentAdmission,
  decidePreparedMutationIntentAdmission,
  decidePreparedMutationRecovery,
  decideMutationIntentSettlement,
  expiredExecutionPlanTerminalReason,
  mutationRecoveryIsDue,
  mutationIntentReconciliationDelayMs,
  executionSubmitExpiresAt,
  executionCycleHasFilledIntent,
} from './observe-composition/mutation-decisions'
import {
  blockedEntryRequiresCloseOnlyContainment,
  decideExecutionCycleCloseDocument,
  decideUnboundExecutionCycleTerminalization,
  decideReconciledExecutionCycleCompletion,
  decideReconciledExecutionCycleTerminalization,
  executionMutationSubmissionAllowed,
  isExecutionCycleReconciledFlat,
  prepareNextMutationIntent,
  terminalizeBlockedExecutionCycle,
} from './observe-composition/execution-cycle'
import { executeMutationIntent } from './observe-composition/mutation-interpreter'
import {
  loadStrategyExecutionRiskPolicy,
  makeMutationAutonomousCycleStartup as makeMutationAutonomousCycleStartupProduction,
  makeObserveAutonomousCycleStartup as makeObserveAutonomousCycleStartupProduction,
  prepareObserveStartup,
} from './observe-composition/startup'
import { recoveryFirstCycleNextDelayMs } from './observe-composition/recovery-driver'
import {
  type MutationAutonomousCycleInput,
  type ObserveAutonomousCycleInput,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverOwner,
} from './observe-composition/model'
import { runMutationPassWithinTimeout, selectClosingSymbolPass } from './observe-composition/decision-builder'
import { ensureExecutionCycleClosure, recoverBoundExecutionContext } from './observe-composition/execution-cycle'
import { prepareMutationIntent } from './observe-composition/mutation-intent-interpreter'
import { makeExecutionCycleClosure } from './db/execution-cycle-closure'
import {
  AccountStatus,
  Authority,
  IntentState,
  MutationOutcome,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type AccountSnapshot,
  type Intent,
  type Order,
  type Position,
  type Reconciliation,
} from './execution/contracts'
import type { ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './simulation-reconciliation/broker-model'
import type { Policy } from './risk'
import { decodeExecutionDecisionDocument, makeExecutionDecisionDocument } from './shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from './target-planner/index'
import { currentUtcInstant, utcInstantFromEpochMillis } from './time'
import type { IsoDate } from './types'

const signalDate = '2020-04-30'
const executionDate = '2020-05-01'
const accountId = 'paper-account-1'
const generationHash = 'a'.repeat(64)
const accountingHash = 'b'.repeat(64)
const reconciledAt = '2020-05-01T16:44:59.000Z'
const evaluatedAt = '2020-05-01T16:45:02.000Z'

const unusedAuthority = Effect.die(new Error('fixture must not read or change authority'))
const unusedAuthorityStore: AuthorityGenerationStoreShape = {
  ensureAuthorityGeneration: () => unusedAuthority,
  readOrInitializeObserveAuthority: () => unusedAuthority,
  readAuthorityState: unusedAuthority,
  readResearchAuthorityGeneration: () => unusedAuthority,
  readAuthorityGenerationLineage: () => unusedAuthority,
}

type JevTestServices = JevBatchStore | JevEvaluationStore | JevClient | JevPositionStore

const provideJevTestServices = <A, E, R>(program: Effect.Effect<A, E, R>) => {
  const unexpected = Effect.die('Composition fixture uses already committed Jev entry evidence')
  return program.pipe(
    Effect.provideService(JevBatchStore, {
      read: () => unexpected,
      pending: () => Effect.succeed([]),
      begin: (plan) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => ({
            plan,
            dispatches: [],
            result: nativeJevBatchResult(plan, utcInstantFromEpochMillis(now), (symbol) =>
              symbol === 'NVDA' ? 'enter' : 'wait',
            ),
          })),
        ),
      finish: () => unexpected,
    }),
    Effect.provideService(JevEvaluationStore, {
      read: () => unexpected,
      record: () => unexpected,
      abandon: () => unexpected,
    }),
    Effect.provideService(JevClient, { evaluate: () => unexpected }),
    Effect.provideService(JevPositionStore, {
      read: () => unexpected,
    }),
  )
}

const ownRecoveryFirstCycleInTestProcess: RecoveryFirstCycleDriverOwner = (driver) => {
  const run = (): ReturnType<RecoveryFirstCycleDriverOwner> =>
    Effect.suspend(() =>
      driver.advance.pipe(
        Effect.flatMap((advance) => Effect.sleep(Duration.millis(advance.nextDelayMs ?? driver.nextDelayMs))),
        Effect.catch((restrictionError) => Effect.die(restrictionError)),
        Effect.andThen(run()),
      ),
    )
  return run()
}

const makeObserveAutonomousCycleStartup =
  (input: ObserveAutonomousCycleInput, owner: RecoveryFirstCycleDriverOwner = ownRecoveryFirstCycleInTestProcess) =>
  (startup: Parameters<ReturnType<typeof makeObserveAutonomousCycleStartupProduction>>[0]) =>
    makeObserveAutonomousCycleStartupProduction(input)(startup).pipe(
      Effect.map((driver) => driver.pipe(Effect.flatMap(owner))),
    )

const makeMutationAutonomousCycleStartup =
  (input: MutationAutonomousCycleInput, owner: RecoveryFirstCycleDriverOwner = ownRecoveryFirstCycleInTestProcess) =>
  (startup: Parameters<ReturnType<typeof makeMutationAutonomousCycleStartupProduction>>[0]) =>
    makeMutationAutonomousCycleStartupProduction(input)(startup).pipe(
      Effect.map((driver) => driver.pipe(Effect.flatMap(owner))),
    )

test('Restate scheduling never waits past the reconciliation cadence', () => {
  expect(recoveryFirstCycleNextDelayMs({ pollIntervalMs: 300_000, reconciliationIntervalMs: 30_000 })).toBe(30_000)
  expect(recoveryFirstCycleNextDelayMs({ pollIntervalMs: 15_000, reconciliationIntervalMs: 30_000 })).toBe(15_000)
})

test('execution submissions use the cycle entry cutoff and the final close-session cutoff', () => {
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      phase: 'ENTRY',
      submissionCutoffAt: '2020-05-01T17:00:00.000Z',
      observedAt: '2020-05-01T16:59:59.000Z',
    }),
  ).toBe(true)
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      phase: 'ENTRY',
      submissionCutoffAt: '2020-05-01T17:00:00.000Z',
      observedAt: '2020-05-01T17:00:00.000Z',
    }),
  ).toBe(false)
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      phase: 'CLOSE',
      submissionCutoffAt: '2020-05-03T20:00:00.000Z',
      observedAt: '2020-05-01T17:05:00.000Z',
    }),
  ).toBe(true)
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      phase: 'CLOSE',
      submissionCutoffAt: '2020-05-03T20:00:00.000Z',
      observedAt: '2020-05-03T20:00:00.000Z',
    }),
  ).toBe(false)
})

test('close-only recovery allows only close submissions strictly before the deadline', () => {
  const boundary = { submissionCutoffAt: '2026-09-11T20:00:00.000Z', observedAt: '2026-09-11T19:55:00.000Z' }
  expect(executionMutationSubmissionAllowed({ ...boundary, capability: 'CloseOnly', phase: 'ENTRY' })).toBe(false)
  expect(executionMutationSubmissionAllowed({ ...boundary, capability: 'CloseOnly', phase: 'CLOSE' })).toBe(true)
  expect(executionMutationSubmissionAllowed({ ...boundary, capability: 'RecoveryOnly', phase: 'CLOSE' })).toBe(false)
  expect(
    executionMutationSubmissionAllowed({
      ...boundary,
      capability: 'CloseOnly',
      phase: 'CLOSE',
      observedAt: boundary.submissionCutoffAt,
    }),
  ).toBe(false)
})

test.each(['RecoveryOnly', 'CloseOnly', 'Mutation'] as const)(
  '%s preserves an untouched native cycle only through its admission lease',
  (capability) => {
    for (const observedAt of [cycle.createdAt, utcInstantFromEpochMillis(unusedEntryExpiresAt(cycle) - 1)]) {
      expect(decideUnboundExecutionCycleTerminalization({ capability, observedAt, cycle })).toBeUndefined()
    }
    expect(
      decideUnboundExecutionCycleTerminalization({ capability, observedAt: cycle.window.submissionCutoffAt, cycle }),
    ).toBe(CycleTerminalReason.UnusedEntryExpired)
  },
)

test('a native empty admission expires before close-only authority can strand its slot at the cutoff', () => {
  expect(
    decideUnboundExecutionCycleTerminalization({
      capability: 'CloseOnly',
      observedAt: cycle.window.submissionCutoffAt,
      cycle,
    }),
  ).toBe(CycleTerminalReason.UnusedEntryExpired)
})

test('preservation does not include a partially bound snapshot', () => {
  expect(
    decideUnboundExecutionCycleTerminalization({
      capability: 'RecoveryOnly',
      observedAt: cycle.window.submissionOpenAt,
      cycle: { ...cycle, bindings: { snapshotId: 'a'.repeat(64) } },
    }),
  ).toBe(CycleTerminalReason.Authority)
})

test.each(['RecoveryOnly', 'CloseOnly'] as const)(
  '%s startup preserves its open unbound cycle without discovering a replacement',
  async (executionMode) => {
    const observedAt = evaluatedAt
    const terminalCycle = Effect.runSync(
      Schema.decodeUnknownEffect(
        AutonomousCycleSchema,
        strictParseOptions,
      )({
        ...cycle,
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.Authority,
        stateVersion: cycle.stateVersion + 1,
        updatedAt: observedAt,
        terminalAt: observedAt,
      }),
    )
    let blockCount = 0
    const forbidden = (capability: string) => Effect.die(new Error(`restricted cycle must not use ${capability}`))
    const cycleStore: CycleStoreShape = {
      acquire: () => forbidden('cycle acquisition'),
      read: () => forbidden('cycle read by ID'),
      readAuthoritySlot: () => forbidden('authority-slot read'),
      readOldestUnfinished: () => Effect.succeed(blockCount === 0 ? Option.some(cycle) : Option.none()),
      readDecisionDocument: () => forbidden('decision document read'),
      activate: () => forbidden('cycle activation'),
      bindDecision: () => forbidden('decision binding'),
      finish: () => forbidden('cycle finishing'),
      block: (cycleId, reason, blockedAt) =>
        Effect.sync(() => {
          blockCount += 1
          expect({ cycleId, reason, blockedAt }).toEqual({
            cycleId: cycle.identity.cycleId,
            reason: CycleTerminalReason.Authority,
            blockedAt: observedAt,
          })
          return { cycle: terminalCycle, changed: true }
        }),
    }
    const reconciliationServices = makeExactReconciliationServices()
    const executionStore = reconciliationServices.executionStore

    const advances = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        const driverEffect = yield* makeMutationAutonomousCycleStartupProduction(
          {
            accountId,
            authorityGenerationHash: generationHash,
            pollIntervalMs: 30_000,
            reconciliationIntervalMs: 30_000,
            reconciliationPassTimeoutMs: 30_000,
            strategy: currentIntradayRuntime,
            executionProgram: sandboxExecutionProgram(),
          },
          executionMode,
        )({
          cycleBindingId: cycle.identity.qualificationRunId,
          recordPass: () => Effect.void,
        })
        const driver = yield* driverEffect
        const blocked = yield* driver.advance
        const waiting = yield* driver.advance
        return { blocked, waiting }
      }).pipe(
        Effect.provideService(BrokerRead, reconciliationServices.brokerRead),
        Effect.provideService(CycleStore, cycleStore),
        Effect.provideService(BrokerEventStore, executionStore),
        Effect.provideService(FillAccountingStore, executionStore),
        Effect.provideService(ValuationStore, executionStore),
        Effect.provideService(ReconciliationStore, executionStore),
        Effect.provideService(AuthorityGenerationStore, executionStore),
        Effect.provideService(AuthorityRestrictionStore, executionStore),
        Effect.provideService(IntentStore, {} as IntentStoreService),
        Effect.provideService(MutationStore, {} as MutationStoreShape),
        Effect.provideService(WriterFence, reconciliationServices.writerFence),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(advances.blocked.result).toEqual({ outcome: 'WINDOW_CLOSED', observedAt })
    expect(advances.waiting.result).toEqual({ outcome: 'WINDOW_CLOSED', observedAt })
    expect(blockCount).toBe(0)
  },
)

test('preserves execution authority after the next bound-cycle reconciliation fails transiently', async () => {
  const fixture = await executionLifecycleFixture()
  const reconciliationServices = makeExactReconciliationServices(Authority.Execution)
  const transientRead = new BrokerReadError({
    operation: 'account',
    kind: BrokerReadErrorKind.Transport,
    message: 'injected transient bound-cycle account read failure',
    retryable: true,
  })
  let accountReads = 0
  let authorityRestrictions = 0
  const brokerRead: BrokerReadShape = {
    ...reconciliationServices.brokerRead,
    account: Effect.suspend(() => {
      accountReads += 1
      return accountReads === 1 ? reconciliationServices.brokerRead.account : Effect.fail(transientRead)
    }),
    marketCalendar: calendarRead([]),
  }
  const executionStore = {
    ...reconciliationServices.executionStore,
    restrictAuthority: () =>
      Effect.sync(() => {
        authorityRestrictions += 1
      }),
  }
  const unusedCycleMutation = Effect.die(new Error('bound-cycle reconciliation failure must not mutate cycle state'))
  const cycleStore: CycleStoreShape = {
    acquire: () => unusedCycleMutation,
    read: () => unusedCycleMutation,
    readAuthoritySlot: () => unusedCycleMutation,
    readDecisionDocument: () => Effect.succeed(Option.some(fixture.document)),
    readOldestUnfinished: () => Effect.succeed(Option.some(fixture.boundCycle)),
    activate: () => unusedCycleMutation,
    bindDecision: () => unusedCycleMutation,
    finish: () => unusedCycleMutation,
    block: () => unusedCycleMutation,
  }
  const storedIntents = new Map(
    fixture.intents.map((intent) => [
      intent.intentId,
      storedIntent(intent, IntentState.Terminal, intent.createdAt, TerminalOutcome.Filled),
    ]),
  )
  const intentStore: IntentStoreService = {
    protectionForCycle: () => Effect.succeed([]),
    beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
    commit: (intent) =>
      Effect.sync(() => {
        const record = storedIntents.get(intent.intentId)
        if (record === undefined) throw new Error('bound intent is missing from the fixture store')
        return { record, deduplicated: true }
      }),
    read: (intentId) => Effect.succeed(Option.fromNullishOr(storedIntents.get(intentId))),
  }
  const mutationStore = {
    latest: () => Effect.void,
  } as unknown as MutationStoreShape

  const advance = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const driverEffect = yield* makeMutationAutonomousCycleStartupProduction(fixture.input)({
        cycleBindingId: fixture.boundCycle.identity.qualificationRunId,
        recordPass: () => Effect.void,
      })
      const driver = yield* driverEffect
      const first = yield* driver.advance
      expect(first.observation).toMatchObject({
        result: 'SUCCESS',
        recoveryAction: 'WAITING',
        waitReason: 'reconciliation-not-later',
      })
      return yield* driver.advance
    }).pipe(
      Effect.provideService(BrokerRead, brokerRead),
      Effect.provideService(CycleStore, cycleStore),
      Effect.provideService(BrokerEventStore, executionStore),
      Effect.provideService(FillAccountingStore, executionStore),
      Effect.provideService(ValuationStore, executionStore),
      Effect.provideService(ReconciliationStore, executionStore),
      Effect.provideService(AuthorityGenerationStore, executionStore),
      Effect.provideService(AuthorityRestrictionStore, executionStore),
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(WriterFence, reconciliationServices.writerFence),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )

  expect(advance.observation).toMatchObject({
    result: 'FAILURE',
    message: 'same-pass broker reconciliation read failed: injected transient bound-cycle account read failure',
  })
  expect(accountReads).toBe(2)
  expect(authorityRestrictions).toBe(0)
})

const calendarMaterial = withProviderSessions({
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: signalDate, end: '2020-05-30' },
  timeZone: 'UTC' as const,
  sessions: [
    {
      date: signalDate,
      openAt: '2020-04-30T13:30:00.000Z',
      closeAt: '2020-04-30T20:00:00.000Z',
    },
    {
      date: executionDate,
      openAt: '2020-05-01T14:00:00.000Z',
      closeAt: '2020-05-01T20:30:00.000Z',
    },
  ],
} as const)

const calendar: MarketCalendarObservation = {
  ...calendarMaterial,
  normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(calendarMaterial)),
}

const currentIntradayProtocol = fixtureProtocol
const currentIntradayDefinition = makeJevDefinition(currentIntradayProtocol)
const currentIntradayRuntime = fixtureRuntime

const executionPolicyResult = makeCycleExecutionPolicyFromModel(currentIntradayProtocol.executionModel)
expect(Result.isSuccess(executionPolicyResult)).toBe(true)
if (Result.isFailure(executionPolicyResult)) {
  expect.unreachable(executionPolicyResult.failure.message)
}
const executionPolicy = executionPolicyResult.success

const executionCalendarResult = makeExecutionCalendarObservation({
  schemaVersion: calendar.schemaVersion,
  source: calendar.source,
  ...calendar.sessions[1],
})
expect(Result.isSuccess(executionCalendarResult)).toBe(true)
if (Result.isFailure(executionCalendarResult)) {
  expect.unreachable(executionCalendarResult.failure.message)
}
const executionCalendar = executionCalendarResult.success

const identityResult = makeCycleIdentity({
  schemaVersion: 'bayn.autonomous-cycle-identity.v4',
  entryAttemptOrdinal: 1,
  strategyName: currentIntradayDefinition.name,
  qualificationRunId: generationHash,
  strategyProtocolHash: makeStrategyProtocolHash(currentIntradayRuntime.provenance.strategy),
  accountId,
  executionSessionDate: executionDate,
  executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
  executionCalendarSource: executionCalendar.executionCalendarSource,
  executionCalendarHash: executionCalendar.executionCalendarHash,
  executionPolicy,
})
expect(Result.isSuccess(identityResult)).toBe(true)
if (Result.isFailure(identityResult)) {
  expect.unreachable(identityResult.failure.message)
}
const identity = identityResult.success

const windowResult = makeIntradayCycleWindow(executionCalendar, executionPolicy)
expect(Result.isSuccess(windowResult)).toBe(true)
if (Result.isFailure(windowResult)) {
  expect.unreachable(windowResult.failure.message)
}
const window = windowResult.success

const draftResult = makeCycleDraft(identity, window)
expect(Result.isSuccess(draftResult)).toBe(true)
if (Result.isFailure(draftResult)) {
  expect.unreachable(draftResult.failure.message)
}
const draft = draftResult.success
const cycle = Effect.runSync(
  Schema.decodeUnknownEffect(
    AutonomousCycleSchema,
    strictParseOptions,
  )({
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 3,
    createdAt: new Date(Date.parse(evaluatedAt) - 1000).toISOString(),
    updatedAt: new Date(Date.parse(evaluatedAt) - 1000).toISOString(),
  }),
)

const account: AccountSnapshot = {
  schemaVersion: 'bayn.paper-account-snapshot.v1',
  accountId,
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '1000000000',
  observedAt: reconciledAt,
}

const reconciliation = (
  positions: readonly Position[] = [],
  orders: readonly Order[] = [],
  brokerAccount: AccountSnapshot = account,
): Reconciliation => {
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account: brokerAccount,
      positions,
      positionsObservedAt: reconciledAt,
      orders,
      ordersObservedAt: reconciledAt,
      accountingHash,
    }),
  )
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt,
  }
  const reconciliationId = Result.getOrThrow(
    canonicalHashV1Result({
      schemaVersion: 'bayn.paper-reconciliation-id.v1',
      material,
    }),
  )
  return {
    ...material,
    reconciliationId,
    contentHash: Result.getOrThrow(canonicalHashV1Result({ ...material, reconciliationId })),
  }
}

const reconciliationResult = (
  authorityGenerationHash = generationHash,
  maximum: Authority = Authority.Observe,
  positions: readonly Position[] = [],
  orders: readonly Order[] = [],
  brokerAccount: AccountSnapshot = account,
): ReconciliationPassResult => {
  const exact = reconciliation(positions, orders, brokerAccount)
  return {
    report: {
      reconciliation: exact,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    brokerState: {
      account: brokerAccount,
      positions,
      positionsObservedAt: reconciledAt,
      orders,
      ordersObservedAt: reconciledAt,
      accountingHash,
      reconciliation: exact,
      unknownOrderCount: 0,
    },
    riskContext: {
      tradingDate: executionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: authorityGenerationHash,
        maximum,
        effective: maximum,
        kill: KillState.Clear,
        version: 1,
        updatedAt: window.submissionOpenAt,
      },
      authorityObservedAt: reconciledAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: brokerAccount.equityMicros,
      peakEquityMicros: brokerAccount.equityMicros,
    },
  }
}

test('one preparation pass reuses fresh reconciliation and refreshes on age or authority change', async () => {
  let reads = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(reconciledAt))
      const initial = reconciliationResult()
      if (initial.riskContext.authority === null) throw new Error('fixture authority missing')
      let authority = initial.riskContext.authority
      const { read } = yield* reconciliationForPreparation(
        initial,
        Effect.gen(function* () {
          reads += 1
          const now = yield* currentUtcInstant
          return {
            ...initial,
            brokerState: {
              ...initial.brokerState,
              account: { ...initial.brokerState.account, observedAt: now },
              positionsObservedAt: now,
              ordersObservedAt: now,
            },
            report: { ...initial.report, reconciliation: { ...initial.report.reconciliation, reconciledAt: now } },
            riskContext: { ...initial.riskContext, authority, authorityObservedAt: now },
          } satisfies ReconciliationPassResult
        }),
        Effect.sync(() => authority),
        1000,
      )
      expect(yield* read).toBe(initial)
      expect(yield* read).toBe(initial)
      expect(reads).toBe(0)
      yield* TestClock.adjust(1000)
      yield* read
      expect(reads).toBe(1)
      yield* read
      expect(reads).toBe(1)
      if (authority === null) throw new Error('fixture authority missing')
      authority = { ...authority, version: authority.version + 1, kill: KillState.Active, effective: Authority.Observe }
      yield* read
      expect(reads).toBe(2)
      const { read: nextPass } = yield* reconciliationForPreparation(
        undefined,
        Effect.sync(() => {
          reads += 1
          return initial
        }),
        Effect.sync(() => authority),
        1000,
      )
      yield* nextPass
      expect(reads).toBe(3)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test.each(['read', 'readForPricing'] as const)(
  'preparation %s propagates authority read failure without reusing preflight or refreshing',
  async (operation) => {
    const failure = new ExecutionStoreError({
      operation: 'authority',
      failure: 'invariant',
      message: 'durable authority state is missing',
    })
    let authorityReads = 0
    let refreshes = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* reconciliationForPreparation(
          reconciliationResult(),
          Effect.sync(() => {
            refreshes += 1
            return reconciliationResult()
          }),
          Effect.sync(() => {
            authorityReads += 1
          }).pipe(Effect.andThen(Effect.fail(failure))),
          30_000,
        )
        return yield* (
          operation === 'read' ? cache.read.pipe(Effect.asVoid) : cache.readForPricing(1_000).pipe(Effect.asVoid)
        ).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBe(failure)
    expect(authorityReads).toBe(1)
    expect(refreshes).toBe(0)
  },
)

test.each([19_999, 20_000, 29_999])('pricing reserves quote headroom when cached facts are %sms old', async (ageMs) => {
  let refreshes = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const initial = reconciliationResultAt(utcInstantFromEpochMillis(Date.parse(evaluatedAt) - ageMs))
      const current = reconciliationResultAt(evaluatedAt)
      if (current.riskContext.authority === null) throw new Error('fixture authority missing')
      const cache = yield* reconciliationForPreparation(
        initial,
        Effect.sync(() => {
          refreshes += 1
          return current
        }),
        Effect.succeed(current.riskContext.authority),
        30_000,
      )
      // Pricing cannot use the ordinary preflight first-use exception.
      const priced = yield* cache.readForPricing(fixtureProtocol.maximumQuoteAgeMs)
      expect(priced.reconciliation).toBe(ageMs < 20_000 ? initial : current)
      expect(priced.freshUntil).toBeGreaterThan(Date.parse(evaluatedAt) + fixtureProtocol.maximumQuoteAgeMs)
      yield* TestClock.adjust(2_000)
      expect(yield* cache.read).toBe(priced.reconciliation)
      expect(refreshes).toBe(ageMs < 20_000 ? 0 : 1)
      yield* TestClock.setTime(Date.parse(priced.reconciliation.brokerState.account.observedAt) + 30_000)
      yield* cache.read
      expect(refreshes).toBe(ageMs < 20_000 ? 1 : 2)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test.each([20_000, 25_000, 29_999, 30_000, 35_000])(
  'pricing and follow-up reads reuse broker-valid facts %sms old within one preparation',
  async (ageMs) => {
    let refreshes = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const now = Date.parse(evaluatedAt)
        yield* TestClock.setTime(now)
        const initial = reconciliationResultAt(utcInstantFromEpochMillis(now - ageMs))
        if (initial.riskContext.authority === null) throw new Error('fixture authority missing')
        const cache = yield* reconciliationForPreparation(
          initial,
          Effect.gen(function* () {
            refreshes += 1
            yield* TestClock.adjust(9_642)
            return reconciliationResultAt(yield* currentUtcInstant)
          }),
          Effect.succeed(initial.riskContext.authority),
          300_000,
        )
        const priced = yield* cache.readForPricing(10_000)
        expect(priced.reconciliation).toBe(initial)
        expect(priced.freshUntil).toBe(now - ageMs + 300_000)
        expect(yield* Clock.currentTimeMillis).toBe(now)
        expect(refreshes).toBe(0)
        yield* TestClock.adjust(30_000)
        yield* cache.read
        expect(refreshes).toBe(0)
        yield* TestClock.setTime(now - ageMs + 300_000)
        yield* cache.read
        expect(refreshes).toBe(1)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },
)

test.each([
  'old-observations',
  'commit-latency',
  'authority-latency',
  'future',
  'missing',
  'generation',
  'version',
] as const)('pricing rechecks %s after its single refresh without extending observations', async (reason) => {
  let refreshes = 0
  let authorityReads = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const initial = reconciliationResultAt(utcInstantFromEpochMillis(Date.parse(evaluatedAt) - 25_000))
      const refreshed = reconciliationResultAt(
        utcInstantFromEpochMillis(
          Date.parse(evaluatedAt) + (reason === 'future' ? 1_000 : reason === 'old-observations' ? -20_000 : -19_000),
        ),
      )
      const result =
        reason === 'missing'
          ? { ...refreshed, riskContext: { ...refreshed.riskContext, authority: null, authorityObservedAt: null } }
          : refreshed
      const originalAuthority = refreshed.riskContext.authority
      if (originalAuthority === null) throw new Error('fixture requires authority')
      const cache = yield* reconciliationForPreparation(
        initial,
        Effect.gen(function* () {
          refreshes += 1
          if (reason === 'commit-latency') yield* TestClock.adjust(1_000)
          return result
        }),
        Effect.gen(function* () {
          authorityReads += 1
          if (authorityReads === 2 && reason === 'authority-latency') yield* TestClock.adjust(1_000)
          return authorityReads === 2
            ? {
                ...originalAuthority,
                generationHash: reason === 'generation' ? 'f'.repeat(64) : originalAuthority.generationHash,
                version: reason === 'version' ? originalAuthority.version + 1 : originalAuthority.version,
              }
            : originalAuthority
        }),
        30_000,
      )
      expect(yield* cache.readForPricing(fixtureProtocol.maximumQuoteAgeMs)).toEqual({
        reconciliation: result,
        freshUntil: undefined,
      })
      expect(refreshes).toBe(1)
      expect(authorityReads).toBe(2)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

const calendarRead =
  (
    queries: unknown[],
  ): ((query: {
    readonly start: string
    readonly end: string
  }) => Effect.Effect<ReadResult<MarketCalendarObservation>>) =>
  (query) =>
    Effect.sync(() => {
      queries.push(query)
      return {
        value: calendar,
        evidence: {
          requestId: 'calendar-request',
          status: 200,
          contentHash: 'f'.repeat(64),
          observedAt: reconciledAt,
        },
      }
    })

const decisionBrokerRead = (marketCalendar: BrokerReadShape['marketCalendar']): BrokerReadShape => {
  const unused = Effect.die(new Error('decision building must not use unrelated broker reads'))
  return {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    feeActivities: () => unused,
    fillActivities: () => unused,
    marketCalendar,
  }
}

const provideDecisionServices = <A, E>(
  program: Effect.Effect<A, E, BrokerRead | CandidateObservationStore | JevTestServices>,
  marketCalendar: BrokerReadShape['marketCalendar'],
): Effect.Effect<A, E> =>
  program.pipe(
    Effect.provideService(BrokerRead, decisionBrokerRead(marketCalendar)),
    Effect.provideService(CandidateObservationStore, {
      record: () => Effect.void,
      latestJevWindowEnd: () => Effect.succeed(Option.none()),
    }),
    provideJevTestServices,
  )

const makeExactReconciliationServices = (maximum: Authority = Authority.Observe) => {
  const exact = reconciliationResult(generationHash, maximum)
  const authority = exact.riskContext.authority
  if (authority === null) throw new Error('exact reconciliation fixture requires durable authority')
  const evidence = (identity: string): ReadEvidence => ({
    requestId: `exact-reconciliation-${identity}`,
    status: 200,
    contentHash: Result.getOrThrow(canonicalHashV1Result({ identity })),
    observedAt: reconciledAt,
  })
  const brokerAccount: BrokerAccount = {
    cryptoStatus: null,
    cashReportingQuantumMicros: '1' as const,
    nonMarginableBuyingPowerMicros: null,

    id: accountId,
    status: BrokerAccountStatus.Active,
    currency: 'USD',
    cashMicros: account.cashMicros,
    equityMicros: account.equityMicros,
    lastEquityMicros: account.equityMicros,
    buyingPowerMicros: account.buyingPowerMicros,
    accountBlocked: false,
    tradingBlocked: false,
    tradeSuspendedByUser: false,
    observedAt: reconciledAt,
  }
  const unusedRead = Effect.die(new Error('exact reconciliation used an unrelated broker capability'))
  const brokerRead: BrokerReadShape = {
    account: Effect.succeed({ value: brokerAccount, evidence: evidence('account') }),
    accountConfiguration: unusedRead,
    assetBySymbol: unusedAssetBySymbol,
    positions: Effect.succeed({ value: [], evidence: evidence('positions') }),
    orders: () => Effect.succeed({ value: [], evidence: evidence('orders') }),
    orderById: () => unusedRead,
    orderByClientId: () => unusedRead,
    feeActivities: () => Effect.succeed({ value: { items: [] }, evidence: evidence('fees') }),
    fillActivities: () => Effect.succeed({ value: { items: [] }, evidence: evidence('fills') }),
    marketCalendar: () => unusedRead,
  }
  const persisted: ReconciliationWriteResult = {
    reconciliation: exact.report.reconciliation,
    metrics: exact.report.metrics,
    accountingHash: exact.brokerState.accountingHash,
    riskContext: exact.riskContext,
  }
  const unusedAccounting = Effect.die(new Error('empty exact reconciliation must not account a fill'))
  const executionStore = {
    ...unusedAuthorityStore,
    completeHistory: () => Effect.succeed(new Set()),
    ingest: () => Effect.succeed({ eventId: '1'.repeat(64), sourceSequence: '1', deduplicated: false }),
    ingestPositions: () => Effect.succeed({ snapshotId: '2'.repeat(64), eventIds: [], deduplicated: false }),
    account: () => unusedAccounting,
    verifyCompleted: () => Effect.void,
    value: () =>
      Effect.succeed({
        schemaVersion: 'bayn.paper-valuation.v1' as const,
        valuationId: '3'.repeat(64),
        accountId,
        sourceHash: '4'.repeat(64),
        cashMicros: account.cashMicros,
        longMarketValueMicros: '0',
        shortMarketValueMicros: '0',
        equityMicros: account.equityMicros,
        asOf: reconciledAt,
      }),
    hasAccountBaseline: () => Effect.succeed(true),
    retainCashReporting: () => Effect.void,
    bindings: () => Effect.succeed([]),
    reconcile: (_, snapshot) => snapshot.pipe(Effect.map((snapshot) => ({ snapshot, persisted }))),
    ensureAuthorityGeneration: () => Effect.succeed(authority),
    readAuthorityState: Effect.succeed(authority),
    restrictAuthority: () => Effect.die(new Error('exact reconciliation unexpectedly restricted authority')),
  } satisfies BrokerEventStoreShape &
    FillAccountingStoreShape &
    ValuationStoreShape &
    ReconciliationStoreShape &
    AuthorityGenerationStoreShape &
    AuthorityRestrictionStoreShape
  const writerFence: WriterFenceService = {
    check: Effect.void,
    transaction: (effect) => effect,
  }
  return { brokerRead, executionStore, writerFence }
}

const sandboxExecutionProgram = (
  authorityGenerationHash = generationHash,
  strategy = currentIntradayRuntime.provenance.strategy,
): ExecutionProgram => {
  const brokerIdentity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId,
    }),
  )
  const authority = Result.getOrThrow(
    makeExecutionAuthority({
      brokerIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: grantedCapitalAuthority(authorityGenerationHash),
      strategy,
      observedAt: evaluatedAt,
    }),
  ) as ExecutionProgram['authority']
  const unused = Effect.die(new Error('execution program operation must not run during startup validation'))
  return {
    _tag: 'ExecutionProgram',
    schemaVersion: 'bayn.execution-program.v1',
    authority,
    recordReconciliation: () => Effect.void,
    invalidateBrokerState: Effect.void,
    dryRunSubmit: () => unused,
    submit: () => unused,
    cancel: () => unused,
    cancelProtectionOrder: () => unused,
    recover: () => unused,
  }
}

const executionLifecycleFixture = async (transformPolicy: (policy: Policy) => Policy = (policy) => policy) => {
  const snapshotRequests: IntradaySnapshotRequest[] = []
  const intradayMarketData: IntradayMarketDataService = {
    check: Effect.void,
    loadSnapshot: (query) =>
      Effect.sync(() => {
        snapshotRequests.push({ ...query, archiveWatermarks: [] })
        return streamingFixtureFromRaw(
          makeIntradayMomentumTestSnapshot(
            currentIntradayProtocol,
            { ...query, archiveWatermarks: [] },
            { NVDA: 0.02 },
            10,
          ),
          query,
        ).snapshot
      }),
    verifyReference: fixtureStreamingReference,
  }
  const input = {
    accountId,
    authorityGenerationHash: generationHash,
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: currentIntradayRuntime,
    intradayMarketData,
    executionProgram: sandboxExecutionProgram(),
  } as const
  const preparation = Result.getOrThrow(prepareObserveStartup(input))
  const policy = transformPolicy(
    await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentIntradayRuntime)),
  )
  const document = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: currentIntradayProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
        strategy: currentIntradayRuntime,
        intradayMarketData,
      })
    }).pipe((program) => provideDecisionServices(program, calendarRead([])), Effect.provide(TestClock.layer())),
  )
  const boundCycle = Effect.runSync(
    Schema.decodeUnknownEffect(
      AutonomousCycleSchema,
      strictParseOptions,
    )({
      ...cycle,
      bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
      stateVersion: cycle.stateVersion + 1,
      updatedAt: document.createdAt,
    }),
  )
  const intents = await Promise.all(
    document.targetPlan.intentTargets.map(async (target, index) => {
      const risk = document.deltaRisk[index]
      if (risk === undefined) throw new Error('PAPER lifecycle fixture risk binding is missing')
      return Effect.runPromise(
        planExecutionIntent(
          {
            schemaVersion: 'bayn.intent-plan.v3',
            ...target,
            notionalLimitMicros: risk.notionalLimitMicros,
            limitPriceMicros: risk.limitPriceMicros,
            ...(risk.protection === undefined ? {} : { protection: risk.protection }),
            createdAt: document.createdAt,
          },
          {
            authority: {
              schemaVersion: 'bayn.paper-authority.v1',
              generationHash,
              maximum: Authority.Execution,
              effective: Authority.Execution,
              kill: KillState.Clear,
              version: 1,
              updatedAt: document.createdAt,
            },
          },
        ),
      )
    }),
  )
  const intent = intents[0]
  const risk = document.deltaRisk[0]
  if (intent === undefined || risk === undefined) throw new Error('PAPER lifecycle fixture requires one planned intent')
  return { boundCycle, document, input, intent, intents, policy, preparation, risk, snapshotRequests }
}

const reconciliationResultAt = (
  observedAt: string,
  unknownMutationCount = 0,
  unknownOrderCount = 0,
  positions: readonly Position[] = [],
  orders: readonly Order[] = [],
  effectiveAuthority: Authority = Authority.Execution,
): ReconciliationPassResult => {
  const result = reconciliationResult(generationHash, Authority.Execution, positions, orders)
  const authority = result.riskContext.authority
  if (authority === null) throw new Error('post-cutoff reconciliation fixture requires PAPER authority')
  const account = { ...result.brokerState.account, observedAt }
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt: observedAt,
      orders,
      ordersObservedAt: observedAt,
      accountingHash,
    }),
  )
  const material = {
    ...result.report.reconciliation,
    expectedHash: stateHash,
    observedHash: stateHash,
    reconciledAt: observedAt,
  }
  const reconciliationId = Result.getOrThrow(
    canonicalHashV1Result({
      schemaVersion: 'bayn.paper-reconciliation-id.v1',
      material,
    }),
  )
  const exact = {
    ...material,
    reconciliationId,
    contentHash: Result.getOrThrow(canonicalHashV1Result({ ...material, reconciliationId })),
  }
  return {
    report: {
      ...result.report,
      reconciliation: exact,
    },
    brokerState: {
      ...result.brokerState,
      account,
      positionsObservedAt: observedAt,
      ordersObservedAt: observedAt,
      reconciliation: exact,
      unknownOrderCount,
    },
    riskContext: {
      tradingDate: result.riskContext.tradingDate,
      dailyTradedNotionalMicros: result.riskContext.dailyTradedNotionalMicros,
      dayStartEquityMicros: result.riskContext.dayStartEquityMicros,
      peakEquityMicros: result.riskContext.peakEquityMicros,
      authority: {
        ...authority,
        effective: effectiveAuthority,
        kill: effectiveAuthority === Authority.Execution ? KillState.Clear : KillState.Active,
      },
      authorityObservedAt: observedAt,
      unknownMutationCount,
    },
  }
}

const storedIntent = (
  intent: Intent,
  state: IntentState,
  updatedAt: string,
  terminalOutcome?: TerminalOutcome,
): StoredIntent => ({
  intent: {
    ...intent,
    state,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
  },
  stateVersion: 2,
  updatedAt,
})

test.each(['complete', 'missing', 'planned', 'planned-risk', 'conflicting'] as const)(
  'prepares %s durable intents without replaying completed commits',
  async (kind) => {
    const fixture = await executionLifecycleFixture()
    const records = new Map<string, StoredIntent>()
    for (const [index, intent] of fixture.intents.entries()) {
      const decision = fixture.document.deltaRisk[index]?.evaluation.decision
      if (decision === undefined) throw new Error('missing fixture risk decision')
      if (kind === 'missing') continue
      records.set(intent.intentId, {
        intent: {
          ...intent,
          state: kind === 'planned' || kind === 'planned-risk' ? IntentState.Planned : IntentState.Approved,
          ...(kind === 'planned' || kind === 'planned-risk' ? {} : { riskDecisionId: decision.decisionId }),
        },
        ...(kind === 'planned'
          ? {}
          : { decision: kind === 'conflicting' ? { ...decision, inputHash: 'f'.repeat(64) } : decision }),
        stateVersion: 2,
        updatedAt: evaluatedAt,
      })
    }
    let commits = 0
    const facts = reconciliationResultAt(evaluatedAt)
    const authority = facts.riskContext.authority
    if (authority === null) throw new Error('missing fixture authority')
    const run = prepareMutationIntent(
      fixture.input,
      fixture.preparation,
      fixture.policy,
      fixture.boundCycle,
      fixture.document,
      Effect.succeed(facts),
      true,
      false,
      {
        now: Effect.succeed(evaluatedAt),
        readFacts: () =>
          Effect.succeed({
            snapshot: {
              contentHash: fixture.document.bindings.snapshotContentHash,
              finalizedAt: fixture.document.bindings.snapshotFinalizedAt,
            },
            reconciliation: facts,
            authority,
            evaluatedAt,
          }),
        restrictAuthority: () => Effect.die(new Error('unexpected authority restriction')),
      },
    ).pipe(
      Effect.provideService(IntentStore, {
        protectionForCycle: () => Effect.succeed([]),
        beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
        read: (id) => Effect.sync(() => Option.fromUndefinedOr(records.get(id))),
        commit: (intent, decision) =>
          Effect.sync(() => {
            commits += 1
            const record = {
              intent: { ...intent, state: IntentState.Approved, riskDecisionId: decision.decisionId },
              decision,
              stateVersion: 2,
              updatedAt: evaluatedAt,
            }
            records.set(intent.intentId, record)
            return { record, deduplicated: false }
          }),
      }),
      Effect.provideService(MutationStore, {
        latest: () => Effect.void,
      } as unknown as MutationStoreShape),
    )
    if (kind === 'planned' || kind === 'planned-risk') {
      expect(await Effect.runPromise(run.pipe(Effect.result))).toMatchObject({
        _tag: 'Failure',
        failure: {
          failure: 'contract',
          message: 'durable planned execution intent violates atomic approval persistence',
        },
      })
      expect(commits).toBe(0)
      return
    }
    if (kind === 'conflicting') {
      expect(Exit.isFailure(await Effect.runPromiseExit(run))).toBe(true)
      expect(commits).toBe(0)
      return
    }
    expect(await Effect.runPromise(run)).toMatchObject({ _tag: 'Execute', action: 'SUBMIT' })
    expect(await Effect.runPromise(run)).toMatchObject({ _tag: 'Execute', action: 'SUBMIT' })
    expect(commits).toBe(kind === 'missing' ? fixture.intents.length : 0)
  },
)

const prepareStoredExecutionStep = async (
  fixture: Awaited<ReturnType<typeof executionLifecycleFixture>>,
  record: StoredIntent,
  latest: MutationEvent | undefined,
  observedAt: string,
  unknownMutationCount = 0,
  onRestriction: (reason: string, updatedAt: string) => void = () => undefined,
  input: typeof fixture.input & {
    readonly mutationPhase?: 'ENTRY' | 'CLOSE'
    readonly executionCycleCloseSubmitCutoffAt?: string
    readonly executionCycleCloseExpiresAt?: string
  } = fixture.input,
  latestCancel?: MutationEvent,
  allowSubmit = true,
  policy: Policy = fixture.policy,
  preparation = fixture.preparation,
  records: ReadonlyMap<string, StoredIntent> = new Map([[record.intent.intentId, record]]),
  latestSubmits: ReadonlyMap<string, MutationEvent | undefined> = new Map([[record.intent.intentId, latest]]),
  reconciledOrders: readonly Order[] = [],
  document: typeof fixture.document = fixture.document,
  reconciledPositions: readonly Position[] = [],
  effectiveAuthority: Authority = Authority.Execution,
  drainOpenOrders = false,
) => {
  const intentStore: IntentStoreService = {
    protectionForCycle: () => Effect.succeed([]),
    beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
    commit: () => Effect.succeed({ record, deduplicated: true }),
    commitClosing: () => Effect.succeed({ record, deduplicated: true }),
    read: (intentId) => {
      const stored = records.get(intentId)
      return Effect.succeed(stored === undefined ? Option.none() : Option.some(stored))
    },
  }
  const mutationStore = {
    latest: (intentId: string, operation: MutationOperation) =>
      Effect.succeed(operation === MutationOperation.Submit ? latestSubmits.get(intentId) : latestCancel),
  } as unknown as MutationStoreShape
  const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
    restrictAuthority: (reason, updatedAt) => Effect.sync(() => onRestriction(reason, updatedAt)),
  }
  const writerFence: WriterFenceService = {
    check: Effect.void,
    transaction: (effect) => effect,
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(observedAt))
      return yield* prepareNextMutationIntent({
        input,
        preparation,
        policy,
        cycle: fixture.boundCycle,
        document,
        reconcile: Effect.succeed(
          reconciliationResultAt(
            observedAt,
            unknownMutationCount,
            0,
            reconciledPositions,
            reconciledOrders,
            effectiveAuthority,
          ),
        ),
        allowSubmit,
        drainOpenOrders,
      })
    }).pipe(
      Effect.provideService(
        BrokerRead,
        decisionBrokerRead(() =>
          Effect.fail(
            new BrokerReadError({
              operation: 'market-calendar',
              kind: BrokerReadErrorKind.InvalidResponse,
              message: 'Alpaca market-calendar error response is invalid',
              status: 500,
              retryable: false,
            }),
          ),
        ),
      ),
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
      Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
      Effect.provideService(ValuationStore, {} as ValuationStoreShape),
      Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
      Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
      Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
      Effect.provideService(WriterFence, writerFence),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )
}

describe('OBSERVE runtime composition', () => {
  test.each(['consumed', 'pending', 'source-unavailable', 'window-failure', 'mismatched-window', 'fresh'] as const)(
    'Jev entry observation admission preserves the source boundary: %s',
    async (mode) => {
      const calls = { signal: 0, pricing: 0, pending: 0, finish: 0, window: 0, record: 0, batch: 0 }
      const sourceFailure = retryableOperationalError({
        component: 'market-data',
        operation: 'snapshot',
        message: 'entry signal history unavailable',
      })
      const databaseFailure = operationalError({
        component: 'database',
        operation: 'window',
        message: 'entry window read failed',
      })
      const pendingEvidence = mode === 'pending' ? nativeJevDecisionEvidence() : null
      const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentIntradayRuntime))
      const result = await Effect.runPromise(
        TestClock.setTime(Date.parse(evaluatedAt)).pipe(
          Effect.andThen(
            buildMutationShadowCycleDecision({
              authorityGenerationHash: generationHash,
              cycle,
              executionModel: currentIntradayProtocol.executionModel,
              policy,
              reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
              strategy: currentIntradayRuntime,
              intradayMarketData: {
                check: Effect.void,
                verifyReference: fixtureStreamingReference,
                loadSnapshot: (query) =>
                  Effect.suspend(() => {
                    if (query.purpose === undefined) calls.signal += 1
                    else calls.pricing += 1
                    if (mode !== 'fresh' && mode !== 'mismatched-window') return Effect.fail(sourceFailure)
                    const loaded = streamingFixtureFromRaw(
                      makeIntradayMomentumTestSnapshot(
                        currentIntradayProtocol,
                        { ...query, archiveWatermarks: [] },
                        { NVDA: 0.02 },
                        10,
                      ),
                      query,
                    ).snapshot
                    return Effect.succeed(
                      mode === 'mismatched-window'
                        ? { ...loaded, manifest: { ...loaded.manifest, rangeEndAt: '2020-05-01T16:44:00.000Z' } }
                        : loaded,
                    )
                  }),
              },
            }).pipe(
              Effect.provideService(CandidateObservationStore, {
                record: () =>
                  Effect.sync(() => {
                    calls.record += 1
                  }),
                latestJevWindowEnd: () =>
                  Effect.suspend(() => {
                    calls.window += 1
                    return mode === 'window-failure'
                      ? Effect.fail(databaseFailure)
                      : Effect.succeed(mode === 'consumed' ? Option.some('2020-05-01T16:45:00.000Z') : Option.none())
                  }),
              }),
              Effect.provideService(JevBatchStore, {
                read: () => Effect.die('Unexpected batch read'),
                pending: () =>
                  Effect.sync(() => {
                    calls.pending += 1
                    return mode === 'pending' ? ['pending-entry'] : []
                  }),
                finish: () =>
                  Effect.suspend(() => {
                    calls.finish += 1
                    return pendingEvidence === null
                      ? Effect.die('Unexpected batch recovery')
                      : Effect.succeed({ plan: pendingEvidence.batchPlan, result: null })
                  }),
                begin: (plan, observation) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.map((now) => {
                      expect(canonicalHashV1Result(observation)).toEqual(Result.succeed(plan.observationHash))
                      calls.batch += 1
                      return {
                        plan,
                        dispatches: [],
                        result: nativeJevBatchResult(plan, utcInstantFromEpochMillis(now), (symbol) =>
                          symbol === 'NVDA' ? 'enter' : 'wait',
                        ),
                      }
                    }),
                  ),
              }),
              provideJevTestServices,
              Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
              Effect.result,
            ),
          ),
          Effect.provide(TestClock.layer()),
        ),
      )
      if (mode === 'fresh') {
        expect(Result.isSuccess(result)).toBe(true)
        expect(calls).toEqual({ signal: 1, pricing: 1, pending: 1, finish: 0, window: 1, record: 0, batch: 1 })
      } else {
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isSuccess(result)) throw new Error('Expected entry observation to remain unavailable')
        if (mode === 'consumed' || mode === 'pending')
          expect(result.failure).toMatchObject({
            _tag: 'ObserveDecisionAwaitingSignal',
            readiness: { reason: mode === 'consumed' ? 'SIGNAL_WINDOW_OBSERVED' : 'DECISION_PENDING' },
          })
        else if (mode === 'mismatched-window')
          expect(result.failure).toMatchObject({
            cause: { message: 'Jev signal snapshot differs from its admitted window' },
          })
        else expect(result.failure).toBe(mode === 'window-failure' ? databaseFailure : sourceFailure)
        expect(calls).toEqual({
          signal: mode === 'source-unavailable' || mode === 'mismatched-window' ? 1 : 0,
          pricing: 0,
          pending: 1,
          finish: mode === 'pending' ? 1 : 0,
          window: mode === 'pending' ? 0 : 1,
          record: 0,
          batch: 0,
        })
      }
    },
  )

  test('recovers an unfinished intraday cycle only with the current source-controlled risk policy', async () => {
    const fixture = await executionLifecycleFixture()
    const currentProtocol = fixtureProtocol
    const currentDefinition = makeJevDefinition(currentProtocol)
    const currentStrategy = {
      definition: currentDefinition,
      provenance: {
        ...fixtureRuntime.provenance,
        strategy: {
          name: currentDefinition.name,
          behaviorHash: jevBehaviorHash,
          parameterHash: Result.getOrThrow(canonicalHashV1Result(currentDefinition.parameters)),
          parameterSchemaVersion: currentDefinition.parameters.schemaVersion,
        },
      },
    }
    const currentPolicy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentStrategy))

    const recovered = await Effect.runPromise(
      recoverBoundExecutionContext(currentPolicy, fixture.boundCycle, fixture.document),
    )

    expect(recovered.preparation.executionModel).toEqual(currentProtocol.executionModel)
    expect(recovered.policy).toEqual(currentPolicy)
    expect(recovered.policy.allowedSymbols).toEqual([...currentProtocol.universe].sort())
  })

  test('defers causally noncanonical quote-bound entry holdings to close-only containment', () => {
    const blocked = (reason: TargetPlanReason) => ({ status: TargetPlanStatus.Blocked, reason })
    const strategyUniverse = currentIntradayProtocol.universe

    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.ShortPositionNotAllowed),
        [{ symbol: 'AAPL', quantityAtoms: '-1000000000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InputMismatch),
        [{ symbol: 'AAPL', quantityAtoms: '500000000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.IdentityMismatch),
        [{ symbol: 'TSLA', quantityAtoms: '1000000000' }],
        strategyUniverse,
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientBuyLiquidity),
        [{ symbol: 'AAPL', quantityAtoms: '500000000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientBuyLiquidity),
        [{ symbol: 'AAPL', quantityAtoms: '0' }],
        ['AAPL'],
      ),
    ).toBe(false)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientSellLiquidity),
        [{ symbol: 'AAPL', quantityAtoms: '1000000000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientSellLiquidity),
        [{ symbol: 'AAPL', quantityAtoms: '0' }],
        ['AAPL'],
      ),
    ).toBe(false)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InputStale),
        [{ symbol: 'AAPL', quantityAtoms: '500000000' }],
        ['AAPL'],
      ),
    ).toBe(false)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InputMismatch),
        [{ symbol: 'AAPL', quantityAtoms: '1000000000' }],
        ['AAPL'],
      ),
    ).toBe(false)
  })

  test('closes external holdings before quote-bound in-universe holdings', () => {
    const positions = [
      { symbol: 'AAPL', quantityAtoms: '1000000000' },
      { symbol: 'TSLA', quantityAtoms: '2000000000' },
    ]

    expect(selectClosingSymbolPass(positions, ['AAPL'])).toEqual({
      kind: 'broker-position',
      symbols: ['TSLA'],
    })
    expect(
      selectClosingSymbolPass(
        positions.filter(({ symbol }) => symbol === 'AAPL'),
        ['AAPL'],
      ),
    ).toEqual({ kind: 'quote-bound', symbols: ['AAPL'] })
  })

  test('each recovery pass selects one instrument market before advancing to the remaining holdings', () => {
    const positions = ['TSLA', 'ETH/USD', 'BTC/USD', 'AAPL'].map((symbol) => ({
      symbol,
      quantityAtoms: '1000000000',
    }))
    expect(selectClosingSymbolPass(positions, ['AAPL'])).toEqual({
      kind: 'broker-position',
      symbols: ['BTC/USD', 'ETH/USD'],
    })
    expect(
      selectClosingSymbolPass(
        positions.filter(({ symbol }) => !symbol.includes('/')),
        ['AAPL'],
      ),
    ).toEqual({
      kind: 'broker-position',
      symbols: ['TSLA'],
    })
  })

  test('uses the fractional pass only after external holdings are flat', () => {
    const positions = [
      { symbol: 'AAPL', quantityAtoms: '500000000' },
      { symbol: 'TSLA', quantityAtoms: '250000000' },
    ]

    expect(selectClosingSymbolPass(positions, ['AAPL'])).toEqual({
      kind: 'broker-position',
      symbols: ['TSLA'],
    })
    expect(
      selectClosingSymbolPass(
        positions.filter(({ symbol }) => symbol === 'AAPL'),
        ['AAPL'],
      ),
    ).toEqual({ kind: 'quote-bound', symbols: ['AAPL'] })
  })

  test('projects accepted nonterminal intents as one unresolved order for the next risk pass', () => {
    const intent: Intent = {
      schemaVersion: 'bayn.execution-intent.v5',
      intentId: '1'.repeat(64),
      authorityGenerationHash: generationHash,
      riskDecisionId: '2'.repeat(64),
      strategyName: 'risk-balanced-trend',
      cycleId: '3'.repeat(64),
      decisionHash: '4'.repeat(64),
      policyHash: '5'.repeat(64),
      accountId,
      clientOrderId: 'accepted-prior-intent',
      symbol: 'NVDA',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '1000000000',
      notionalLimitMicros: '100010000',
      limitPriceMicros: '100010000',
      state: IntentState.Acknowledged,
      createdAt: evaluatedAt,
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '6'.repeat(64),
      mutationId: '7'.repeat(64),
      intentId: intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(intent)))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-broker-order',
      occurredAt: evaluatedAt,
    }
    const decision = Result.getOrThrow(decidePreparedMutationIntent(intent, accepted))
    expect(decision._tag).toBe('Pending')
    if (decision._tag !== 'Pending') return expect.unreachable(decision._tag)
    expect(decision.order).toMatchObject({
      brokerOrderId: accepted.brokerOrderId,
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      orderType: OrderType.Limit,
      limitPriceMicros: intent.limitPriceMicros,
      quantityAtoms: intent.quantityAtoms,
      status: OrderStatus.New,
      filledQuantityAtoms: '0',
    })

    const reconciledOrder: Order = {
      ...decision.order,
      observedAt: utcInstantFromEpochMillis(Date.parse(evaluatedAt) + 1_000),
    }
    expect(Result.getOrThrow(decidePendingMutationObservation(decision.order, [reconciledOrder]))).toEqual({
      _tag: 'StableOpen',
      order: reconciledOrder,
    })
    expect(
      Result.getOrThrow(
        decidePendingMutationObservation(decision.order, [
          { ...reconciledOrder, status: OrderStatus.Filled, filledQuantityAtoms: intent.quantityAtoms },
        ]),
      ),
    ).toMatchObject({ _tag: 'Recover', reason: 'terminal' })
    expect(Result.getOrThrow(decidePendingMutationObservation(decision.order, []))).toEqual({
      _tag: 'Recover',
      reason: 'missing',
    })
    expect(
      Result.isFailure(decidePendingMutationObservation(decision.order, [{ ...reconciledOrder, symbol: 'AMD' }])),
    ).toBe(true)
    expect(
      Result.isFailure(
        decidePendingMutationObservation(decision.order, [
          {
            ...reconciledOrder,
            notionalMicros: (BigInt(reconciledOrder.notionalMicros ?? '0') + 1n).toString(),
          },
        ]),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decidePendingMutationObservation(decision.order, [
          reconciledOrder,
          { ...reconciledOrder, brokerOrderId: 'conflicting-order' },
        ]),
      ),
    ).toBe(true)
  })

  test.each(['before-expiry', 'after-expiry'] as const)(
    'bounds an acknowledged DAY entry across its immutable expiry: %s',
    async (timing) => {
      const fixture = await executionLifecycleFixture()
      expect(fixture.intents).toHaveLength(1)
      const accepted: MutationEvent = {
        schemaVersion: 'bayn.paper-mutation-event.v1',
        eventId: '1'.repeat(64),
        mutationId: '2'.repeat(64),
        intentId: fixture.intent.intentId,
        sequence: 2,
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitAccepted,
        requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(fixture.intent)))),
        consistencyDelayMs: 1000,
        brokerOrderId: 'stable-open-order',
        occurredAt: fixture.document.createdAt,
      }
      const pending = Result.getOrThrow(decidePreparedMutationIntent(fixture.intent, accepted))
      if (pending._tag !== 'Pending') throw new Error('Expected an acknowledged order')
      const observedAt = utcInstantFromEpochMillis(
        Date.parse(timing === 'before-expiry' ? accepted.occurredAt : fixture.document.submissionCutoffAt) + 1000,
      )
      const step = await prepareStoredExecutionStep(
        fixture,
        storedIntent(fixture.intent, IntentState.Acknowledged, accepted.occurredAt),
        accepted,
        observedAt,
        0,
        () => undefined,
        fixture.input,
        undefined,
        true,
        fixture.policy,
        fixture.preparation,
        undefined,
        undefined,
        [{ ...pending.order, observedAt }],
      )
      expect(step).toEqual(
        timing === 'before-expiry'
          ? { _tag: 'Wait', observedAt, waitReason: 'intent-nonterminal' }
          : { _tag: 'Execute', action: 'CANCEL', intentId: fixture.intent.intentId, observedAt },
      )
    },
  )

  test('drains a legacy open entry order when every-session execution rejects its multi-session strategy', async () => {
    const fixture = await executionLifecycleFixture()
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(fixture.intent)))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'entry-order-to-cancel',
      occurredAt: fixture.document.createdAt,
    }
    const pending = Result.getOrThrow(decidePreparedMutationIntent(fixture.intent, accepted))
    if (pending._tag !== 'Pending') return expect.unreachable('accepted entry intent must be pending')
    const observedAt = utcInstantFromEpochMillis(Date.parse(accepted.occurredAt) + accepted.consistencyDelayMs)
    const step = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, accepted.occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      fixture.input,
      undefined,
      false,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [{ ...pending.order, observedAt }],
      fixture.document,
      [],
      Authority.Execution,
      true,
    )

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
  })

  test('prefers the settled broker rejection to expired Jev entry evidence', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1000)
    const record = storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected)
    const step = await prepareStoredExecutionStep(fixture, record, undefined, observedAt)
    expect(step).toEqual({ _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt })
  })

  test('executes unsubmitted intents and skips terminal intents in fresh mutation passes', () => {
    const base: Intent = {
      schemaVersion: 'bayn.execution-intent.v5',
      intentId: '9'.repeat(64),
      authorityGenerationHash: generationHash,
      strategyName: 'risk-balanced-trend',
      cycleId: 'a'.repeat(64),
      decisionHash: 'b'.repeat(64),
      policyHash: 'c'.repeat(64),
      accountId,
      clientOrderId: 'fresh-pass-intent',
      symbol: 'AMD',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '1000000000',
      notionalLimitMicros: '100000000',
      limitPriceMicros: '100000000',
      state: IntentState.Planned,
      createdAt: evaluatedAt,
    }

    expect(Result.getOrThrow(decidePreparedMutationIntent(base, undefined))).toEqual({ _tag: 'Submit' })
    expect(
      Result.getOrThrow(
        decidePreparedMutationIntent(
          { ...base, state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Filled },
          undefined,
        ),
      ),
    ).toEqual({ _tag: 'SkipTerminal' })
  })

  test('allows lookup recovery after authority restriction and cutoff while forbidding every fresh submit', () => {
    const recover = {
      _tag: 'Recover' as const,
      eventType: MutationEventType.SubmitUnknown,
    }
    expect(
      Result.isSuccess(
        decidePreparedMutationIntentAdmission(
          recover,
          Authority.Observe,
          cycle.window.submissionCutoffAt,
          cycle.window.submissionCutoffAt,
          1,
        ),
      ),
    ).toBe(true)

    const submit = { _tag: 'Submit' as const }
    expect(
      Result.isSuccess(
        decidePreparedCloseIntentAdmission(
          submit,
          evaluatedAt,
          cycle.window.submissionCutoffAt,
          0,
          ReconciliationStatus.Exact,
          true,
          0,
        ),
      ),
    ).toBe(true)
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedCloseIntentAdmission(
            submit,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Discrepancy,
          ),
        ),
      )?.reason,
    ).toBe('reconciliation-not-exact')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Observe,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
          ),
        ),
      )?.reason,
    ).toBe('authority')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            cycle.window.submissionCutoffAt,
            cycle.window.submissionCutoffAt,
            0,
          ),
        ),
      )?.reason,
    ).toBe('expiry')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            1,
          ),
        ),
      )?.reason,
    ).toBe('unknown-mutation')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Discrepancy,
          ),
        ),
      )?.reason,
    ).toBe('reconciliation-not-exact')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Exact,
            false,
          ),
        ),
      )?.reason,
    ).toBe('accounting-inexact')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Exact,
            true,
            1,
          ),
        ),
      )?.reason,
    ).toBe('unknown-order')
  })

  test('chooses cancellation recovery before submit recovery and fresh-policy gates', async () => {
    const fixture = await executionLifecycleFixture()
    const event = (operation: MutationOperation, eventType: MutationEventType): MutationEvent => ({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: Result.getOrThrow(canonicalHashV1Result({ operation, eventType, intentId: fixture.intent.intentId })),
      mutationId: Result.getOrThrow(canonicalHashV1Result({ operation, intentId: fixture.intent.intentId })),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation,
      eventType,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: fixture.document.createdAt,
    })

    const submit = event(MutationOperation.Submit, MutationEventType.SubmitAccepted)
    const cancel = event(MutationOperation.Cancel, MutationEventType.CancelUnknown)

    expect(Result.getOrThrow(decidePreparedMutationRecovery(fixture.intent, submit, cancel))).toEqual({
      _tag: 'Recover',
      operation: MutationOperation.Cancel,
      event: cancel,
    })
  })

  test('keeps OBSERVE recovery-only execution lookup-capable while fresh submit remains structurally unavailable', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const submitUnknown: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitUnknown,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(fixture.intent)))),
      consistencyDelayMs: 1_000,
      occurredAt,
    }
    const cancelUnknown: MutationEvent = {
      ...submitUnknown,
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelUnknown,
      requestHash: '6'.repeat(64),
      brokerOrderId: 'recovery-only-order',
    }

    const backingOff = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      submitUnknown,
      occurredAt,
      1,
      () => undefined,
      fixture.input,
      cancelUnknown,
      false,
    )
    expect(backingOff).toEqual({ _tag: 'Wait', observedAt: occurredAt, waitReason: 'MUTATION_RECOVERY_BACKOFF' })

    const recovery = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      submitUnknown,
      observedAt,
      1,
      () => undefined,
      fixture.input,
      cancelUnknown,
      false,
    )
    expect(recovery).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })

    let commits = 0
    const intentStore: IntentStoreService = {
      protectionForCycle: () => Effect.succeed([]),
      beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('OBSERVE recovery-only execution must not commit a fresh PAPER intent')
        }),
      read: () => Effect.succeed(Option.none()),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const waiting = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareNextMutationIntent({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: fixture.document,
          reconcile: Effect.die(
            new Error('OBSERVE recovery-only execution must not reconcile before refusing fresh submit'),
          ),
          allowSubmit: false,
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(waiting).toEqual({ _tag: 'Wait', observedAt, waitReason: 'SUBMISSION_NOT_ALLOWED' })
    expect(commits).toBe(0)
  })

  test('completes PAPER only after every intent is filled and a later exact reconciliation closes unknowns', () => {
    const intentUpdatedAt = '2020-05-01T16:45:03.000Z'
    const laterReconciliation = {
      status: ReconciliationStatus.Exact,
      reconciledAt: '2020-05-01T16:45:04.000Z',
      accountingExact: true,
      unknownMutationCount: 0,
      unknownOrderCount: 0,
      openPositionCount: 0,
    } as const
    const filled = {
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
      updatedAt: intentUpdatedAt,
      latestMutationAt: intentUpdatedAt,
    } as const

    expect(
      decideExecutionPhaseCompletion(
        'CLOSE',
        evaluatedAt,
        [
          {
            state: IntentState.Acknowledged,
            updatedAt: filled.updatedAt,
            latestMutationAt: filled.latestMutationAt,
          },
        ],
        laterReconciliation,
      ),
    ).toEqual({ _tag: 'Wait', reason: 'intent-nonterminal' })
    expect(
      decideExecutionPhaseCompletion(
        'CLOSE',
        evaluatedAt,
        [{ ...filled, terminalOutcome: TerminalOutcome.Rejected }],
        laterReconciliation,
      ),
    ).toEqual({ _tag: 'Wait', reason: 'intent-unsuccessful' })
    expect(
      decideExecutionPhaseCompletion('CLOSE', evaluatedAt, [filled], {
        ...laterReconciliation,
        reconciledAt: intentUpdatedAt,
      }),
    ).toEqual({ _tag: 'Wait', reason: 'reconciliation-not-later' })
    expect(
      decideExecutionPhaseCompletion('CLOSE', evaluatedAt, [filled], {
        ...laterReconciliation,
        unknownMutationCount: 1,
      }),
    ).toEqual({ _tag: 'Wait', reason: 'unknown-mutation' })
    expect(decideExecutionPhaseCompletion('CLOSE', evaluatedAt, [filled], laterReconciliation)).toEqual({
      _tag: 'Complete',
    })
    const held = { ...laterReconciliation, openPositionCount: 1 }
    expect(decideExecutionPhaseCompletion('ENTRY', evaluatedAt, [filled], held)).toEqual({ _tag: 'Complete' })
    expect(decideExecutionPhaseCompletion('CLOSE', evaluatedAt, [filled], held)).toEqual({
      _tag: 'Wait',
      reason: 'open-position',
    })
    for (const blocked of [
      { ...held, reconciledAt: intentUpdatedAt },
      { ...held, accountingExact: false },
      { ...held, unknownMutationCount: 1 },
      { ...held, unknownOrderCount: 1 },
    ])
      expect(decideExecutionPhaseCompletion('ENTRY', evaluatedAt, [filled], blocked)._tag).toBe('Wait')
    const partial = {
      ...filled,
      terminalOutcome: TerminalOutcome.Canceled,
      terminalDisposition: 'PARTIAL_FILL_LIMIT' as const,
    }
    expect(decideExecutionPhaseCompletion('ENTRY', evaluatedAt, [partial], held)).toEqual({ _tag: 'Complete' })
    expect(decideExecutionPhaseCompletion('CLOSE', evaluatedAt, [partial], held)).toEqual({
      _tag: 'Wait',
      reason: 'intent-unsuccessful',
    })
    expect(countOpenPositions([{ quantityAtoms: '0' }, { quantityAtoms: '-1000' }, { quantityAtoms: '2000' }])).toBe(2)
  })

  test('completes an entry after an exact zero-fill LIMIT/IOC cancellation without containing authority', () => {
    const intent = {
      accountId,
      clientOrderId: `b1_${'Z'.repeat(43)}`,
      intentId: '9'.repeat(64),
      orderType: OrderType.Limit,
      quantityAtoms: '3000000000',
      side: OrderSide.Buy,
      state: IntentState.Terminal,
      symbol: 'AMD',
      terminalOutcome: TerminalOutcome.Canceled,
      timeInForce: TimeInForce.Day,
    } as const
    const order = {
      accountId,
      brokerOrderId: 'zero-fill-ioc-order',
      clientOrderId: intent.clientOrderId,
      filledQuantityAtoms: '0',
      intentId: intent.intentId,
      orderType: intent.orderType,
      quantityAtoms: intent.quantityAtoms,
      side: intent.side,
      status: OrderStatus.Canceled,
      symbol: intent.symbol,
      timeInForce: intent.timeInForce,
    } as const
    const dispositionInput = {
      intent,
      acceptedBrokerOrderId: order.brokerOrderId,
      orders: [order],
    } as const

    expect(decideExecutionIntentTerminalDisposition({ ...dispositionInput, phase: 'ENTRY' })).toBe(
      'BENIGN_ZERO_FILL_LIMIT',
    )
    expect(
      decideExecutionIntentTerminalDisposition({
        ...dispositionInput,
        phase: 'ENTRY',
        orders: [{ ...order, filledQuantityAtoms: '1000' }],
      }),
    ).toBe('PARTIAL_FILL_LIMIT')
    expect(decideExecutionIntentTerminalDisposition({ ...dispositionInput, phase: 'CLOSE' })).toBe('UNSUCCESSFUL')
    for (const filledQuantityAtoms of ['-1', intent.quantityAtoms, '4000000000']) {
      expect(
        decideExecutionIntentTerminalDisposition({
          ...dispositionInput,
          phase: 'ENTRY',
          orders: [{ ...order, filledQuantityAtoms }],
        }),
      ).toBe('UNSUCCESSFUL')
    }
    for (const divergent of [
      { ...order, filledQuantityAtoms: '1000000000', brokerOrderId: 'other-order' },
      { ...order, filledQuantityAtoms: '1000000000', intentId: '8'.repeat(64) },
      { ...order, filledQuantityAtoms: '1000000000', accountId: 'other-account' },
      { ...order, filledQuantityAtoms: '1000000000', status: OrderStatus.PartiallyFilled },
    ]) {
      expect(
        decideExecutionIntentTerminalDisposition({ ...dispositionInput, phase: 'ENTRY', orders: [divergent] }),
      ).toBe('UNSUCCESSFUL')
    }
    expect(
      decideExecutionIntentTerminalDisposition({ ...dispositionInput, phase: 'ENTRY', orders: [order, order] }),
    ).toBe('UNSUCCESSFUL')
    expect(decideExecutionIntentTerminalDisposition({ intent, phase: 'ENTRY', orders: [order] })).toBe('UNSUCCESSFUL')

    expect(
      decideExecutionPhaseCompletion(
        'ENTRY',
        evaluatedAt,
        [
          {
            state: IntentState.Terminal,
            terminalOutcome: TerminalOutcome.Canceled,
            terminalDisposition: 'BENIGN_ZERO_FILL_LIMIT',
            updatedAt: '2020-05-01T16:45:03.000Z',
            latestMutationAt: '2020-05-01T16:45:03.000Z',
          },
        ],
        {
          status: ReconciliationStatus.Exact,
          reconciledAt: '2020-05-01T16:45:04.000Z',
          accountingExact: true,
          unknownMutationCount: 0,
          unknownOrderCount: 0,
          openPositionCount: 0,
        },
      ),
    ).toEqual({ _tag: 'Complete' })
  })

  test('completes an already-flat cycle without constructing a close plan', () => {
    const flat = {
      report: {
        reconciliation: { status: ReconciliationStatus.Exact },
        metrics: { accountingExact: true },
      },
      brokerState: {
        positions: [],
        orders: [{ status: OrderStatus.Canceled }],
        unknownOrderCount: 0,
      },
      riskContext: { unknownMutationCount: 0 },
    } as const

    expect(isExecutionCycleReconciledFlat(flat)).toBe(true)
    expect(
      isExecutionCycleReconciledFlat({
        ...flat,
        brokerState: { ...flat.brokerState, orders: [{ status: OrderStatus.Pending }] },
      }),
    ).toBe(false)
    expect(
      isExecutionCycleReconciledFlat({
        ...flat,
        brokerState: { ...flat.brokerState, positions: [{ quantityAtoms: '1000' }] },
      }),
    ).toBe(false)
    expect(isExecutionCycleReconciledFlat({ ...flat, riskContext: { unknownMutationCount: 1 } })).toBe(false)
  })

  test('uses the persisted reconciliation time when completing an already-flat cycle', () => {
    const reconciliationCompletedAt = '2020-05-01T16:45:04.000Z'
    const flatReconciliation = reconciliationResultAt(reconciliationCompletedAt)

    expect(decideReconciledExecutionCycleCompletion(flatReconciliation)).toEqual({
      _tag: 'Complete',
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'COMPLETE')).toEqual({
      _tag: 'Complete',
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'BENIGN_ZERO_FILL')).toEqual({
      _tag: 'Complete',
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'MISSING')).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'UNSUCCESSFUL')).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: reconciliationCompletedAt,
    })
  })

  test('settles terminal submit denials and broker rejections so later cycles can continue', () => {
    expect(decideMutationIntentSettlement(MutationEventType.SubmitRejected)).toEqual({
      _tag: 'Settled',
      outcome: 'rejected',
    })

    expect(decideMutationIntentSettlement(MutationEventType.SubmitDenied)).toEqual({
      _tag: 'Settled',
      outcome: 'denied',
    })
    expect(decideMutationIntentSettlement(MutationEventType.SubmitUnknown)).toEqual({
      _tag: 'Unresolved',
      eventType: MutationEventType.SubmitUnknown,
    })
    expect(decideMutationIntentSettlement(MutationEventType.CancelAccepted)).toEqual({
      _tag: 'Settled',
      outcome: 'accepted',
    })
    expect(decideMutationIntentSettlement(MutationEventType.CancelUnknown)).toEqual({
      _tag: 'Unresolved',
      eventType: MutationEventType.CancelUnknown,
    })
  })

  test('waits the durable consistency window only after accepted submit settlement', () => {
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'accepted' },
        consistencyDelayMs: 1_250,
        operation: MutationOperation.Submit,
        mutationAdvanced: true,
      }),
    ).toBe(1_250)
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'rejected' },
        consistencyDelayMs: 1_250,
        operation: MutationOperation.Submit,
        mutationAdvanced: true,
      }),
    ).toBe(0)
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'accepted' },
        consistencyDelayMs: 1_250,
        operation: MutationOperation.Submit,
        mutationAdvanced: false,
      }),
    ).toBe(0)
  })

  test('replays a terminal rejection without resubmission and executes the later-cycle intent', async () => {
    const rejectedIntentId = 'a'.repeat(64)
    const laterIntentId = 'b'.repeat(64)
    const event = (intentId: string, eventType: MutationEventType) => ({
      schemaVersion: 'bayn.paper-mutation-event.v1' as const,
      eventId: Result.getOrThrow(canonicalHashV1Result({ intentId, eventType })),
      mutationId: Result.getOrThrow(canonicalHashV1Result({ intentId, operation: 'SUBMIT' })),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: evaluatedAt,
    })
    const rejected = event(rejectedIntentId, MutationEventType.SubmitRejected)
    const accepted = event(laterIntentId, MutationEventType.SubmitAccepted)
    const submitted: string[] = []
    const submitDeadlines: string[] = []
    let recoveries = 0
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: (intentId, _consistencyDelayMs, submitExpiresAt) =>
        Effect.sync(() => {
          submitted.push(intentId)
          submitDeadlines.push(submitExpiresAt)
          return accepted
        }),
      recover: () =>
        Effect.sync(() => {
          recoveries += 1
          return accepted
        }),
    }
    const store = {
      latest: (intentId: string) => Effect.succeed(intentId === rejectedIntentId ? rejected : undefined),
    } as unknown as MutationStoreShape

    await Effect.runPromise(
      Effect.forEach(
        [rejectedIntentId, laterIntentId],
        (intentId) => executeMutationIntent(program, intentId, 'SUBMIT', '9999-12-31T23:59:59.999Z'),
        {
          concurrency: 1,
          discard: true,
        },
      ).pipe(Effect.provideService(MutationStore, store)),
    )

    expect(submitted).toEqual([laterIntentId])
    expect(submitDeadlines).toEqual(['9999-12-31T23:59:59.999Z'])
    expect(recoveries).toBe(0)
  })

  test('dispatches one fresh cancellation while recovery actions remain lookup-only', async () => {
    const intentId = 'd'.repeat(64)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'e'.repeat(64),
      mutationId: 'f'.repeat(64),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-broker-order',
      occurredAt: evaluatedAt,
    }
    const { brokerOrderId: _acceptedBrokerOrderId, ...acceptedWithoutBrokerOrderId } = accepted
    const unknownEvent: MutationEvent = {
      ...acceptedWithoutBrokerOrderId,
      eventId: '2'.repeat(64),
      eventType: MutationEventType.SubmitUnknown,
    }
    const cancelAccepted: MutationEvent = {
      ...accepted,
      eventId: '3'.repeat(64),
      mutationId: '4'.repeat(64),
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelAccepted,
      requestHash: '5'.repeat(64),
    }
    const cancelUnknown: MutationEvent = {
      ...cancelAccepted,
      eventId: '6'.repeat(64),
      eventType: MutationEventType.CancelUnknown,
    }
    const dueAt = utcInstantFromEpochMillis(Date.parse(evaluatedAt) + accepted.consistencyDelayMs)
    expect(mutationRecoveryIsDue(accepted, utcInstantFromEpochMillis(Date.parse(dueAt) - 1))).toBe(false)
    expect(mutationRecoveryIsDue(accepted, dueAt)).toBe(true)
    expect(executionSubmitExpiresAt(cycle.window.submissionCutoffAt, evaluatedAt)).toBe(evaluatedAt)
    expect(executionSubmitExpiresAt(evaluatedAt, cycle.window.submissionCutoffAt)).toBe(evaluatedAt)

    let submits = 0
    let cancels = 0
    const recoveries: MutationOperation[] = []
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: () =>
        Effect.sync(() => {
          submits += 1
          return accepted
        }),
      cancel: () =>
        Effect.sync(() => {
          cancels += 1
          return cancelAccepted
        }),
      recover: (_intentId, operation) =>
        Effect.sync(() => {
          recoveries.push(operation)
          return {
            ...(operation === MutationOperation.Submit ? accepted : cancelAccepted),
            eventId: Result.getOrThrow(
              canonicalHashV1Result({ intentId, operation, eventType: MutationEventType.RecoveryFound }),
            ),
            eventType: MutationEventType.RecoveryFound,
          }
        }),
    }
    let latestSubmit: MutationEvent | undefined = accepted
    let latestCancel: MutationEvent | undefined
    const store = {
      latest: (_intentId: string, operation: MutationOperation) =>
        Effect.succeed(operation === MutationOperation.Submit ? latestSubmit : latestCancel),
    } as unknown as MutationStoreShape

    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_SUBMIT').pipe(Effect.provideService(MutationStore, store)),
    )
    latestSubmit = unknownEvent
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_SUBMIT').pipe(Effect.provideService(MutationStore, store)),
    )
    latestSubmit = accepted
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'CANCEL').pipe(Effect.provideService(MutationStore, store)),
    )
    latestCancel = cancelAccepted
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_CANCEL').pipe(Effect.provideService(MutationStore, store)),
    )
    latestCancel = cancelUnknown
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_CANCEL').pipe(Effect.provideService(MutationStore, store)),
    )

    expect(submits).toBe(0)
    expect(cancels).toBe(1)
    expect(recoveries).toEqual([
      MutationOperation.Submit,
      MutationOperation.Submit,
      MutationOperation.Cancel,
      MutationOperation.Cancel,
    ])

    const missingStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const failure = await Effect.runPromise(
      Effect.flip(
        executeMutationIntent(program, intentId, 'RECOVER_SUBMIT').pipe(
          Effect.provideService(MutationStore, missingStore),
        ),
      ),
    )
    expect(failure).toMatchObject({
      failure: 'contract',
      message: 'lookup-only execution recovery lost its durable submit evidence',
    })
    const cancelFailure = await Effect.runPromise(
      Effect.flip(
        executeMutationIntent(program, intentId, 'RECOVER_CANCEL').pipe(
          Effect.provideService(MutationStore, missingStore),
        ),
      ),
    )
    expect(cancelFailure).toMatchObject({
      failure: 'contract',
      message: 'lookup-only execution recovery lost its durable cancel evidence',
    })
    expect(submits).toBe(0)
    expect(cancels).toBe(1)
  })

  test('classifies an identical stable recovery observation as read-only', async () => {
    const intentId = '7'.repeat(64)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '8'.repeat(64),
      mutationId: '9'.repeat(64),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.RecoveryFound,
      requestHash: 'a'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'stable-open-order',
      occurredAt: evaluatedAt,
    }
    const result = await Effect.runPromise(
      executeMutationIntent(
        {
          ...sandboxExecutionProgram(),
          recover: () => Effect.succeed(accepted),
        },
        intentId,
        'RECOVER_SUBMIT',
      ).pipe(
        Effect.provideService(MutationStore, {
          latest: () => Effect.succeed(accepted),
        } as unknown as MutationStoreShape),
      ),
    )

    expect(result).toEqual({
      settlement: { _tag: 'Settled', outcome: 'accepted' },
      consistencyDelayMs: 1_000,
      operation: MutationOperation.Submit,
      mutationAdvanced: false,
    })
    expect(mutationIntentReconciliationDelayMs(result)).toBe(0)
  })

  test('keeps an accepted pending intent lookup-recoverable after its immutable submission cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const afterCutoff = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Acknowledged, fixture.document.createdAt)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(fixture.intent)))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-past-cutoff',
      occurredAt: fixture.document.createdAt,
    }

    const step = await prepareStoredExecutionStep(fixture, record, accepted, afterCutoff)

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt: afterCutoff,
    })
  })

  test('keeps an unknown submit lookup-recoverable after its immutable submission cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const afterCutoff = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Unknown, fixture.document.createdAt)
    const unknown: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitUnknown,
      requestHash: '6'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: fixture.document.createdAt,
    }

    const step = await prepareStoredExecutionStep(fixture, record, unknown, afterCutoff, 1)

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt: afterCutoff,
    })
  })

  test('never creates a fresh submit POST once the immutable cutoff is reached', async () => {
    const fixture = await executionLifecycleFixture()
    let submits = 0
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: () =>
        Effect.sync(() => {
          submits += 1
          throw new Error('fresh submit must not reach broker I/O after cutoff')
        }),
    }
    const store = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(fixture.document.submissionCutoffAt))
          return yield* executeMutationIntent(
            program,
            fixture.intent.intentId,
            'SUBMIT',
            fixture.document.submissionCutoffAt,
          )
        }).pipe(Effect.provideService(MutationStore, store), Effect.provide(TestClock.layer())),
      ),
    )

    expect(failure).toMatchObject({
      failure: 'contract',
      message: 'fresh broker submit crossed its immutable submission cutoff before broker I/O',
    })
    expect(submits).toBe(0)
  })

  test('does not restrict PAPER authority when the causal cycle block is rejected', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = fixture.document.submissionCutoffAt
    const unused = Effect.die(new Error('failed PAPER terminalization used an unrelated store operation'))
    let restrictions = 0
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => unused,
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: () =>
        Effect.fail(
          new CycleStoreError({
            operation: 'block',
            failure: 'query',
            persistenceFailure: 'constraint',
            message: 'open mutation prevents cycle block',
          }),
        ),
    }
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: () =>
        Effect.sync(() => {
          restrictions += 1
        }),
    }
    const writerFence: WriterFenceService = {
      check: unused,
      transaction: (effect) => effect,
    }
    const blockedCycleIntentStore: BlockedCycleIntentStoreShape = {
      settleCurrentTerminalGeneration: () => Effect.die(new Error('startup recovery is outside this unit boundary')),
      terminalizeUntouchedApproved: () => Effect.die(new Error('rejected cycle block must not terminalize intents')),
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        terminalizeBlockedExecutionCycle(
          fixture.boundCycle,
          {
            _tag: 'Block',
            reason: CycleTerminalReason.MissedSubmission,
            observedAt,
          },
          generationHash,
          blockedCycleIntentStore,
        ).pipe(
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
          Effect.provideService(WriterFence, writerFence),
          Effect.provideService(CandidateObservationStore, {
            record: () => Effect.void,
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
          }),
          provideJevTestServices,
        ),
      ),
    )

    expect(failure).toMatchObject({
      failure: 'store',
      message: 'blocked execution cycle finalization failed',
    })
    expect(restrictions).toBe(0)
  })

  test.each([
    { label: 'risk expiry minus 1ms', boundary: 'risk', offsetMs: -1, reason: undefined },
    { label: 'risk expiry equality', boundary: 'risk', offsetMs: 0, reason: CycleTerminalReason.Risk },
    { label: 'risk expiry plus 1ms', boundary: 'risk', offsetMs: 1, reason: CycleTerminalReason.Risk },
    { label: 'cutoff minus 1ms', boundary: 'cutoff', offsetMs: -1, reason: CycleTerminalReason.Risk },
    { label: 'cutoff equality', boundary: 'cutoff', offsetMs: 0, reason: CycleTerminalReason.MissedSubmission },
    { label: 'cutoff plus 1ms', boundary: 'cutoff', offsetMs: 1, reason: CycleTerminalReason.MissedSubmission },
  ] as const)(
    'selects expiry recovery for a restricted approved intent at $label',
    async ({ boundary, offsetMs, reason }) => {
      const fixture = await executionLifecycleFixture()
      const riskExpiresAt = fixture.risk.evaluation.decision.expiresAt
      expect(Date.parse(riskExpiresAt) + 1).toBeLessThan(Date.parse(fixture.document.submissionCutoffAt))
      const observedAt = utcInstantFromEpochMillis(
        Date.parse(boundary === 'risk' ? riskExpiresAt : fixture.document.submissionCutoffAt) + offsetMs,
      )
      const record = storedIntent(fixture.intent, IntentState.Approved, fixture.document.createdAt)
      const restrictions: string[] = []
      const step = await prepareStoredExecutionStep(
        fixture,
        record,
        undefined,
        observedAt,
        0,
        (restriction) => restrictions.push(restriction),
        fixture.input,
        undefined,
        false,
        fixture.policy,
        fixture.preparation,
        undefined,
        undefined,
        [],
        fixture.document,
        [],
        Authority.Observe,
      )

      expect(step).toEqual(
        reason === undefined
          ? { _tag: 'Wait', observedAt, waitReason: 'SUBMISSION_NOT_ALLOWED' }
          : { _tag: 'Block', reason, observedAt },
      )
      expect(restrictions).toEqual([])
    },
  )

  test.each([
    { eventType: MutationEventType.SubmitStarted, operation: MutationOperation.Submit, state: IntentState.IoStarted },
    { eventType: MutationEventType.SubmitUnknown, operation: MutationOperation.Submit, state: IntentState.Unknown },
    {
      eventType: MutationEventType.SubmitAccepted,
      operation: MutationOperation.Submit,
      state: IntentState.Acknowledged,
    },
    { eventType: MutationEventType.RecoveryFound, operation: MutationOperation.Submit, state: IntentState.Recovered },
    {
      eventType: MutationEventType.CancelStarted,
      operation: MutationOperation.Cancel,
      state: IntentState.Acknowledged,
    },
    {
      eventType: MutationEventType.CancelAccepted,
      operation: MutationOperation.Cancel,
      state: IntentState.Acknowledged,
    },
    { eventType: MutationEventType.CancelUnknown, operation: MutationOperation.Cancel, state: IntentState.Unknown },
  ])('preserves $eventType recovery ahead of restricted intent expiry', async ({ eventType, operation, state }) => {
    const fixture = await executionLifecycleFixture()
    const observedAt = fixture.risk.evaluation.decision.expiresAt
    const occurredAt = utcInstantFromEpochMillis(Date.parse(observedAt) - 1_000)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(fixture.intent)))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'restricted-expiry-recovery-order',
      occurredAt,
    }
    const event: MutationEvent = {
      ...accepted,
      eventId: '3'.repeat(64),
      mutationId: '4'.repeat(64),
      operation,
      eventType,
    }
    const latestSubmit = operation === MutationOperation.Submit ? event : accepted
    const latestCancel = operation === MutationOperation.Cancel ? event : undefined
    const record = storedIntent(fixture.intent, state, occurredAt)
    const restrictions: string[] = []
    const step = await prepareStoredExecutionStep(
      fixture,
      record,
      latestSubmit,
      observedAt,
      1,
      (restriction) => restrictions.push(restriction),
      fixture.input,
      latestCancel,
      false,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [],
      fixture.document,
      [],
      Authority.Observe,
    )

    expect(step).toEqual({
      _tag: 'Execute',
      action: operation === MutationOperation.Submit ? 'RECOVER_SUBMIT' : 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(restrictions).toEqual([])
  })

  test('terminalizes an untouched PAPER remainder when its durable approval expires', async () => {
    const fixture = await executionLifecycleFixture()
    const riskExpiresAt = fixture.risk.evaluation.decision.expiresAt
    expect(riskExpiresAt < fixture.document.submissionCutoffAt).toBe(true)
    expect(expiredExecutionPlanTerminalReason(riskExpiresAt, riskExpiresAt, fixture.document.submissionCutoffAt)).toBe(
      CycleTerminalReason.Risk,
    )
    expect(
      expiredExecutionPlanTerminalReason(
        fixture.document.submissionCutoffAt,
        fixture.document.submissionCutoffAt,
        fixture.document.submissionCutoffAt,
      ),
    ).toBe(CycleTerminalReason.MissedSubmission)

    const record = storedIntent(fixture.intent, IntentState.Approved, fixture.document.createdAt)
    const step = await prepareStoredExecutionStep(fixture, record, undefined, riskExpiresAt)

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: riskExpiresAt,
    })
  })

  test('terminalizes an uncommitted execution intent at approval expiry before any durable commit', async () => {
    const fixture = await executionLifecycleFixture()
    const riskExpiresAt = fixture.risk.evaluation.decision.expiresAt
    let reads = 0
    let commits = 0
    const intentStore: IntentStoreService = {
      protectionForCycle: () => Effect.succeed([]),
      beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('expired uncommitted execution intent must not reach durable commit')
        }),
      read: () =>
        Effect.sync(() => {
          reads += 1
          return Option.none()
        }),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: () =>
        Effect.die(new Error('pre-commit expiry must not restrict authority before cycle block')),
    }
    const writerFence: WriterFenceService = {
      check: Effect.die(new Error('pre-commit expiry must not enter the writer fence')),
      transaction: () => Effect.die(new Error('pre-commit expiry must not open a writer-fenced transaction')),
    }

    const step = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(riskExpiresAt))
        return yield* prepareNextMutationIntent({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: fixture.document,
          reconcile: Effect.die(new Error('pre-commit expiry must not reconcile or read the broker')),
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
        Effect.provideService(WriterFence, writerFence),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: riskExpiresAt,
    })
    expect(reads).toBe(1)
    expect(commits).toBe(0)
  })

  test('terminalizes a superseded execution generation after proving no mutation exists', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1)
    let intentReads = 0
    let mutationReads = 0
    let commits = 0
    const intentStore: IntentStoreService = {
      protectionForCycle: () => Effect.succeed([]),
      beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('superseded execution generation must not commit an intent')
        }),
      read: () =>
        Effect.sync(() => {
          intentReads += 1
          return Option.none()
        }),
    }
    const mutationStore = {
      latest: () =>
        Effect.sync(() => {
          mutationReads += 1
          return undefined
        }),
    } as unknown as MutationStoreShape

    const step = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareNextMutationIntent({
          input: { ...fixture.input, authorityGenerationHash: 'f'.repeat(64) },
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: fixture.document,
          reconcile: Effect.die(new Error('superseded execution generation must not reconcile or read the broker')),
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(intentReads).toBe(1)
    expect(mutationReads).toBe(2)
    expect(commits).toBe(0)
  })

  test('recovers superseded accepted and unknown submits and cancellations before provenance blocking', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const supersededInput = { ...fixture.input, authorityGenerationHash: 'f'.repeat(64) }
    const driftedPolicy: Policy = {
      ...fixture.policy,
      maxOrderNotionalMicros: (BigInt(fixture.policy.maxOrderNotionalMicros) - 1n).toString(),
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '3'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'superseded-accepted-order',
      occurredAt,
    }
    const { brokerOrderId: _supersededBrokerOrderId, ...acceptedWithoutBrokerOrderId } = accepted
    const unknown: MutationEvent = {
      ...acceptedWithoutBrokerOrderId,
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      eventType: MutationEventType.SubmitUnknown,
    }
    const cancelAccepted: MutationEvent = {
      ...accepted,
      eventId: '6'.repeat(64),
      mutationId: '7'.repeat(64),
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelAccepted,
      requestHash: '8'.repeat(64),
    }
    const cancelUnknown: MutationEvent = {
      ...cancelAccepted,
      eventId: '9'.repeat(64),
      mutationId: 'a'.repeat(64),
      eventType: MutationEventType.CancelUnknown,
    }
    const cancelRecovered: MutationEvent = {
      ...cancelAccepted,
      eventId: 'b'.repeat(64),
      mutationId: 'c'.repeat(64),
      sequence: 3,
      eventType: MutationEventType.RecoveryFound,
    }

    const acceptedStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      undefined,
      true,
      driftedPolicy,
    )
    const unknownStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      unknown,
      observedAt,
      1,
      () => undefined,
      supersededInput,
      undefined,
      true,
      driftedPolicy,
    )
    const cancelAcceptedStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      cancelAccepted,
      true,
      driftedPolicy,
    )
    const cancelUnknownStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      unknown,
      observedAt,
      1,
      () => undefined,
      supersededInput,
      cancelUnknown,
      true,
      driftedPolicy,
    )
    const settledSubmitStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Filled),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      undefined,
      true,
      driftedPolicy,
    )
    const settledCancelStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Canceled),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      cancelRecovered,
      true,
      driftedPolicy,
    )

    expect(acceptedStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(unknownStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(cancelAcceptedStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(cancelUnknownStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(settledSubmitStep).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(settledCancelStep).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(
      Result.getOrThrow(
        decidePreparedMutationRecovery(
          storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Canceled).intent,
          accepted,
          cancelRecovered,
        ),
      ),
    ).toEqual({ _tag: 'NoRecovery' })
  })

  test('recovers old-policy mutation work before rejecting fresh work under the current policy', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const driftedPolicy: Policy = {
      ...fixture.policy,
      maxOrderNotionalMicros: (BigInt(fixture.policy.maxOrderNotionalMicros) - 1n).toString(),
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'd'.repeat(64),
      mutationId: 'e'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: 'f'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'old-policy-accepted-order',
      occurredAt,
    }

    const recovery = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      fixture.input,
      undefined,
      true,
      driftedPolicy,
    )

    const plannedRecord = storedIntent(fixture.intent, IntentState.Planned, occurredAt)
    let commits = 0
    const intentStore: IntentStoreService = {
      protectionForCycle: () => Effect.succeed([]),
      beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('policy drift must fail before a fresh intent re-commit')
        }),
      read: () => Effect.succeed(Option.some(plannedRecord)),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const freshFailure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* Effect.flip(
          prepareNextMutationIntent({
            input: fixture.input,
            preparation: fixture.preparation,
            policy: driftedPolicy,
            cycle: fixture.boundCycle,
            document: fixture.document,
            reconcile: Effect.die(
              new Error('policy drift must fail before reconciliation, broker reads, or fresh submission'),
            ),
          }),
        )
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(recovery).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(freshFailure).toMatchObject({
      _tag: 'CycleRunnerError',
      failure: 'contract',
      message: 'current source-controlled execution risk policy changed from the durable decision binding',
    })
    expect(commits).toBe(0)
  })

  test('terminalizes a known rejected PAPER intent without waiting for cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const rejectedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    expect(rejectedAt < fixture.risk.evaluation.decision.expiresAt).toBe(true)
    const record = storedIntent(fixture.intent, IntentState.Terminal, rejectedAt, TerminalOutcome.Rejected)
    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'a'.repeat(64),
      mutationId: 'b'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: 'c'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'paper-rejected-request',
      responseStatus: 422,
      responseContentHash: 'd'.repeat(64),
      occurredAt: rejectedAt,
    }
    const restrictions: { readonly reason: string; readonly updatedAt: string }[] = []

    const step = await prepareStoredExecutionStep(fixture, record, rejected, rejectedAt, 0, (reason, updatedAt) =>
      restrictions.push({ reason, updatedAt }),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: rejectedAt,
    })
    expect(restrictions).toHaveLength(1)
    expect(restrictions[0]).toMatchObject({
      updatedAt: rejectedAt,
    })
    expect(restrictions[0]?.reason).toContain(`intent ${fixture.intent.intentId} ended REJECTED`)
  })

  test('builds a deterministic close and terminalizes an uncommitted close at its submit cutoff', async () => {
    const fixture = await executionLifecycleFixture((policy) => ({
      ...policy,
      maxBrokerStateAgeMs: 3_600_000,
      maxMarketDataAgeMs: 3_600_000,
    }))
    expect(fixture.intent.symbol).toBe('NVDA')
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const position: Position = {
      schemaVersion: 'bayn.position.v2',
      costBasisMicros: '100000000',
      accountId,
      symbol: fixture.intent.symbol,
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const baseReconciliation = reconciliationResultAt(observedAt, 0, 0, [position])
    const closeAccount = { ...baseReconciliation.brokerState.account, observedAt }
    const closeStateHash = Result.getOrThrow(
      reconciledStateHash({
        account: closeAccount,
        positions: [position],
        positionsObservedAt: observedAt,
        orders: [],
        ordersObservedAt: observedAt,
        accountingHash,
      }),
    )
    const closeReconciliationMaterial = {
      ...baseReconciliation.brokerState.reconciliation,
      expectedHash: closeStateHash,
      observedHash: closeStateHash,
      reconciledAt: observedAt,
    }
    const closeReconciliationId = Result.getOrThrow(
      canonicalHashV1Result({
        schemaVersion: 'bayn.paper-reconciliation-id.v1',
        material: closeReconciliationMaterial,
      }),
    )
    const closeReconciliation = {
      ...closeReconciliationMaterial,
      reconciliationId: closeReconciliationId,
      contentHash: Result.getOrThrow(
        canonicalHashV1Result({ ...closeReconciliationMaterial, reconciliationId: closeReconciliationId }),
      ),
    }
    const currentReconciliation: ReconciliationPassResult = {
      ...baseReconciliation,
      report: { ...baseReconciliation.report, reconciliation: closeReconciliation },
      brokerState: {
        ...baseReconciliation.brokerState,
        account: closeAccount,
        reconciliation: closeReconciliation,
      },
    }
    const buildClose = (
      entryDocument: typeof fixture.document,
      closeReconciliationResult: ReconciliationPassResult = currentReconciliation,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(observedAt))
          return (yield* prepareClosingExecutionCycleDecision({
            input: fixture.input,
            preparation: fixture.preparation,
            policy: fixture.policy,
            cycle: fixture.boundCycle,
            entryDocument,
            reconcile: Effect.succeed(closeReconciliationResult),
            closeExpiresAt,
          })).document
        }).pipe(
          Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
          Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
          Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
          Effect.provideService(ValuationStore, {} as ValuationStoreShape),
          Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
          Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
          Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
          Effect.provideService(WriterFence, {} as WriterFenceService),
          Effect.provideService(CandidateObservationStore, {
            record: () => Effect.void,
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
          }),
          provideJevTestServices,
          Effect.provide(TestClock.layer()),
        ),
      )

    const close = await buildClose(fixture.document)
    const { executionSession: _legacyExecutionSession, ...legacyDocument } = fixture.document
    const legacyFailure = await buildClose(legacyDocument as typeof fixture.document).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(close.executionSession).toEqual(fixture.document.executionSession)
    expect(close.targetPlan.intentTargets).toMatchObject([
      {
        symbol: fixture.intent.symbol,
        side: OrderSide.Sell,
        quantityAtoms: '1000000000',
      },
    ])
    expect(close.targetPlan.intentTargets).toHaveLength(1)
    expect(close.dispatchable).toBe(true)
    expect(close.closeLimitSlippageBps).toBe(fixture.policy.maxAdverseSlippageBps)
    expect(close.entryLimitSlippageBps).toBeUndefined()
    for (const risk of close.deltaRisk) {
      const facts = risk.facts
      if (facts === undefined) throw new Error('close is missing durable risk facts')
      const reference = BigInt(facts.state.referencePriceMicros)
      const limit = BigInt(facts.state.expectedExecutionPriceMicros)
      expect(limit).toBeLessThan(reference)
      expect((reference - limit) * 10_000n).toBeLessThanOrEqual(reference * 10n)
    }
    const { contentHash: _closeHash, ...closeMaterial } = close
    expect(Result.isFailure(makeExecutionDecisionDocument({ ...closeMaterial, closeLimitSlippageBps: 11 }))).toBeTrue()
    expect(Result.isFailure(makeExecutionDecisionDocument({ ...closeMaterial, entryLimitSlippageBps: 10 }))).toBeTrue()
    const { closeLimitSlippageBps: _closeAllowance, ...withoutCloseAllowance } = closeMaterial
    expect(Result.isFailure(makeExecutionDecisionDocument(withoutCloseAllowance))).toBeTrue()
    expect(decideExecutionCycleCloseDocument({ ...close, dispatchable: false })).toEqual({ _tag: 'Block' })
    expect(legacyFailure).toMatchObject({
      _tag: 'CycleRunnerError',
      failure: 'contract',
      message: 'intraday close requires its persisted v3 execution-session binding',
    })

    const committedIntents = new Map<string, StoredIntent>()
    const closeIntentStore: IntentStoreService = {
      protectionForCycle: () => Effect.succeed([]),
      beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
      commit: () => Effect.die(new Error('close admission must use commitClosing')),
      commitClosing: (intent, decision) =>
        Effect.sync(() => {
          const record: StoredIntent = {
            ...storedIntent({ ...intent, riskDecisionId: decision.decisionId }, IntentState.Approved, close.createdAt),
            decision,
          }
          committedIntents.set(intent.intentId, record)
          return { record, deduplicated: false }
        }),
      read: (intentId) => {
        const record = committedIntents.get(intentId)
        return Effect.succeed(record === undefined ? Option.none() : Option.some(record))
      },
    }
    const closeMutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const admission = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareNextMutationIntent({
          input: {
            ...fixture.input,
            mutationPhase: 'CLOSE',
            executionCycleCloseSubmitCutoffAt: closeExpiresAt,
            executionCycleCloseExpiresAt: closeExpiresAt,
          },
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: close,
          reconcile: Effect.succeed(currentReconciliation),
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(IntentStore, closeIntentStore),
        Effect.provideService(MutationStore, closeMutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(admission).toMatchObject({
      _tag: 'Execute',
      action: 'SUBMIT',
      intentId: close.orderedIntentIds[0],
    })

    const missedCloseSubmitCutoffAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 30_000)
    let missedCloseCommits = 0
    const missedCloseIntentStore: IntentStoreService = {
      protectionForCycle: () => Effect.succeed([]),
      beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
      commit: () => Effect.die(new Error('missed close admission must use commitClosing')),
      commitClosing: () =>
        Effect.sync(() => {
          missedCloseCommits += 1
          throw new Error('missed close cutoff must terminalize before durable intent commit')
        }),
      read: () => Effect.succeed(Option.none()),
    }
    const missedClose = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(missedCloseSubmitCutoffAt))
        return yield* prepareNextMutationIntent({
          input: {
            ...fixture.input,
            mutationPhase: 'CLOSE',
            executionCycleCloseSubmitCutoffAt: missedCloseSubmitCutoffAt,
            executionCycleCloseExpiresAt: closeExpiresAt,
          },
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: close,
          reconcile: Effect.succeed(currentReconciliation),
          allowSubmit: false,
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(IntentStore, missedCloseIntentStore),
        Effect.provideService(MutationStore, closeMutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(missedClose).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
      observedAt: missedCloseSubmitCutoffAt,
    })
    expect(missedCloseCommits).toBe(0)
  })

  test('builds an intraday close as a same-session flat execution target', () => {
    const close = Result.getOrThrow(
      makeClosingDecisionPlan(
        {
          strategyName: 'jev',
          executionSessionDate: executionDate,
        },
        ['NVDA', 'AMD', 'NVDA'],
      ),
    )

    expect(close).toEqual({
      schemaVersion: 'bayn.execution-flat-target.v1',
      strategyName: 'jev',
      sessionDate: executionDate,
      targetWeights: { AMD: 0, NVDA: 0 },
      symbols: ['AMD', 'NVDA'],
      reason: 'mandate-close',
    })
  })

  test.each([
    operationalError({
      component: 'market-data',
      operation: 'load',
      message: 'closing quote missing',
      cause: new IntradaySnapshotFailure({ reason: 'not-ready', message: 'closing quote missing' }),
    }),
    operationalError({
      component: 'market-data',
      operation: 'load',
      message: 'closing evidence late',
      cause: new IntradaySnapshotFailure({
        reason: 'freshness',
        message: 'closing evidence late',
        ingestionDelayDirection: IntradayIngestionDelayDirection.AboveMaximum,
      }),
    }),
    retryableOperationalError({ component: 'market-data', operation: 'load', message: 'archive unavailable' }),
  ])('closes reconciled IWM holdings when archive evidence is unavailable: %s', async (archiveFailure) => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.boundCycle.window.executionCloseAt) - 239_000)
    const position: Position = {
      schemaVersion: 'bayn.position.v2',
      costBasisMicros: '3400000000',
      accountId,
      symbol: 'IWM',
      quantityAtoms: '34000000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '3400000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const buildClose = (
      reconciliation = reconciliationResultAt(observedAt, 0, 0, [position]),
      failure = archiveFailure,
      at = observedAt,
      replanGenerationHash?: string,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(at))
          return (yield* prepareClosingExecutionCycleDecision({
            input: {
              ...fixture.input,
              intradayMarketData: { ...fixture.input.intradayMarketData, loadSnapshot: () => Effect.fail(failure) },
            },
            preparation: fixture.preparation,
            policy: fixture.policy,
            cycle: fixture.boundCycle,
            entryDocument: fixture.document,
            reconcile: Effect.succeed(reconciliation),
            ...(replanGenerationHash === undefined ? {} : { replanGenerationHash }),
            closeExpiresAt: fixture.boundCycle.window.executionCloseAt,
          })).document
        }).pipe(
          Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
          Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
          Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
          Effect.provideService(ValuationStore, {} as ValuationStoreShape),
          Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
          Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
          Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
          Effect.provideService(WriterFence, {} as WriterFenceService),
          Effect.provideService(CandidateObservationStore, {
            record: () => Effect.void,
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
          }),
          provideJevTestServices,
          Effect.provide(TestClock.layer()),
        ),
      )
    const close = await buildClose()
    expect(close.dispatchable).toBeTrue()
    expect(close.closeLimitSlippageBps).toBe(fixture.policy.maxAdverseSlippageBps)
    const { contentHash: _closeHash, ...closeMaterial } = close
    expect(Result.isFailure(makeExecutionDecisionDocument({ ...closeMaterial, closeLimitSlippageBps: 11 }))).toBeTrue()
    expect(close.bindings.executionMarketData).toMatchObject({
      schemaVersion: 'bayn.reconciled-position-liquidation-binding.v1',
      symbols: ['IWM'],
      positions: [{ symbol: 'IWM', quantityAtoms: '34000000000' }],
    })
    expect(close.targetPlan.intentTargets).toMatchObject([
      {
        symbol: 'IWM',
        side: OrderSide.Sell,
        quantityAtoms: '34000000000',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
      },
    ])
    expect(close.targetPlan.intentTargets).toHaveLength(1)
    expect((await buildClose()).contentHash).toBe(close.contentHash)
    await expect(buildClose(reconciliationResultAt(observedAt, 1, 0, [position]))).rejects.toMatchObject({
      _tag: 'ExecutionCloseAwaitingReconciliation',
      unknownMutationCount: 1,
    })

    const residual = await buildClose(
      reconciliationResultAt(observedAt, 0, 0, [
        { ...position, quantityAtoms: '1000000000', marketValueMicros: '100000000' },
      ]),
      archiveFailure,
      observedAt,
      close.contentHash,
    )
    expect(residual.targetPlan.intentTargets).toMatchObject([
      { symbol: 'IWM', side: OrderSide.Sell, quantityAtoms: '1000000000' },
    ])
    expect(residual.orderedIntentIds).not.toEqual(close.orderedIntentIds)
    const fractional = await buildClose(
      reconciliationResultAt(observedAt, 0, 0, [
        { ...position, quantityAtoms: '500000000', marketValueMicros: '50000000' },
      ]),
      archiveFailure,
      observedAt,
      residual.contentHash,
    )
    expect(fractional.targetPlan.intentTargets).toMatchObject([
      { symbol: 'IWM', side: OrderSide.Sell, quantityAtoms: '500000000' },
    ])

    for (const reason of ['identity', 'ordering', 'hash', 'lineage', 'rows', 'coverage'] as const) {
      const invalid = operationalError({
        component: 'market-data',
        operation: 'load',
        message: 'invalid archive evidence',
        cause: new IntradaySnapshotFailure({ reason, message: 'invalid archive evidence' }),
      })
      const failure = await buildClose(undefined, invalid).then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(failure).toMatchObject({ _tag: 'CycleRunnerError' })
    }
    const beforeClose = await buildClose(undefined, archiveFailure, fixture.document.createdAt).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(beforeClose).toMatchObject({
      _tag: 'ExecutionCloseAwaitingMarketData',
    })
    const afterClose = await buildClose(undefined, archiveFailure, fixture.boundCycle.window.executionCloseAt).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(afterClose).toMatchObject({ _tag: 'ExecutionCloseAwaitingMarketData' })
  })

  test.each([
    ['initial', 1_000, 17_500],
    ['residual', 1_000, 17_500],
    ['initial', 8_000, 18_001],
    ['residual', 8_000, 18_001],
    ['initial', 11_000, 24_001],
    ['residual', 11_000, 24_001],
  ] as const)(
    'cancels a stuck close archive read during %s closure with %i ms reconciliation within the pass budget',
    async (phase, reconciliationMs, expectedCloseMs) => {
      const fixture = await executionLifecycleFixture()
      const startedAt = Date.parse(fixture.boundCycle.window.executionCloseAt) - 239_000
      let reads = 0
      let reconciliations = 0
      let finalized = 0
      let committedIntents = 0
      const committedRecords = new Map<string, StoredIntent>()
      const terminalIntentIds = new Set(fixture.document.orderedIntentIds)
      const close = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(startedAt)
          const reading = yield* Deferred.make<void>()
          const reconciliationAt = (observedAt: string) =>
            reconciliationResultAt(observedAt, 0, 0, [
              {
                schemaVersion: 'bayn.position.v2',
                costBasisMicros: '100000000',
                accountId,
                symbol: 'IWM',
                quantityAtoms: '1000000000',
                averageEntryPriceMicros: '100000000',
                marketPriceMicros: '100000000',
                marketValueMicros: '100000000',
                unrealizedPnlMicros: '0',
                observedAt,
              },
            ])
          const reconcile = Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(reconciliationMs))
            reconciliations += 1
            const observedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
            return reconciliationAt(observedAt)
          })
          const previousDocument =
            phase === 'initial'
              ? undefined
              : (yield* prepareClosingExecutionCycleDecision({
                  input: fixture.input,
                  preparation: fixture.preparation,
                  policy: fixture.policy,
                  cycle: fixture.boundCycle,
                  entryDocument: fixture.document,
                  closeExpiresAt: fixture.boundCycle.window.executionCloseAt,
                  reconcile: Effect.succeed(reconciliationAt(utcInstantFromEpochMillis(startedAt))),
                })).document
          for (const id of previousDocument?.orderedIntentIds ?? []) terminalIntentIds.add(id)
          const previousClosure =
            previousDocument === undefined
              ? undefined
              : Result.getOrThrow(
                  makeExecutionCycleClosure({
                    schemaVersion: 'bayn.paper-cycle-closure.v1',
                    cycleId: fixture.boundCycle.identity.cycleId,
                    entryDecisionHash: fixture.document.contentHash,
                    document: previousDocument,
                    createdAt: previousDocument.createdAt,
                    expiresAt: previousDocument.expiresAt,
                  }),
                )
          const closing = yield* Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(2))
            const result = yield* ensureExecutionCycleClosure({
              input: {
                ...fixture.input,
                executionCycleClosureStore: {
                  read: () => Effect.succeed(Option.fromUndefinedOr(previousClosure)),
                  readLatestReplan: () => Effect.succeed(Option.none()),
                  bind: (closure) => Effect.succeed(closure),
                  bindReplan: (closure) => Effect.succeed(closure),
                  containsIntent: () => Effect.succeed(false),
                },
                intradayMarketData: {
                  ...fixture.input.intradayMarketData,
                  loadSnapshot: () =>
                    Effect.gen(function* () {
                      reads += 1
                      yield* Deferred.succeed(reading, undefined)
                      return yield* Effect.never
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          finalized += 1
                        }),
                      ),
                    ),
                },
              },
              preparation: fixture.preparation,
              policy: fixture.policy,
              cycle: fixture.boundCycle,
              entryDocument: fixture.document,
              closeWindow: {
                startAt: utcInstantFromEpochMillis(startedAt),
                submitCutoffAt: fixture.boundCycle.window.executionCloseAt,
                expiresAt: fixture.boundCycle.window.executionCloseAt,
              },
              reconcile,
              refreshReconciliation: reconcile,
              existing: previousClosure,
            })
            if (result._tag !== 'Close') throw new Error('expected a created close')
            const admission = yield* prepareNextMutationIntent({
              input: {
                ...fixture.input,
                mutationPhase: 'CLOSE',
                executionCycleCloseSubmitCutoffAt: fixture.boundCycle.window.executionCloseAt,
                executionCycleCloseExpiresAt: fixture.boundCycle.window.executionCloseAt,
              },
              preparation: fixture.preparation,
              policy: fixture.policy,
              cycle: fixture.boundCycle,
              document: result.document,
              reconcile: result.reconciliation === undefined ? reconcile : Effect.succeed(result.reconciliation),
            })
            if (admission._tag !== 'Execute') throw new Error('expected the closing intent to be admitted')
            return result.document
          }).pipe((operation) => runMutationPassWithinTimeout(operation, 30_000), Effect.forkChild)
          yield* TestClock.adjust(Duration.seconds(20))
          yield* Deferred.await(reading)
          yield* TestClock.adjust(Duration.seconds(24))
          return yield* Fiber.join(closing)
        }).pipe(
          Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
          Effect.provideService(IntentStore, {
            protectionForCycle: () => Effect.succeed([]),
            beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
            read: (intentId) =>
              Effect.succeed(
                terminalIntentIds.has(intentId)
                  ? Option.some(
                      storedIntent(
                        { ...fixture.intent, intentId },
                        IntentState.Terminal,
                        utcInstantFromEpochMillis(startedAt),
                      ),
                    )
                  : Option.fromUndefinedOr(committedRecords.get(intentId)),
              ),
            commit: () => Effect.die('close admission must use commitClosing'),
            commitClosing: (intent) =>
              Effect.gen(function* () {
                committedIntents += 1
                const observedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
                const record = storedIntent(intent, IntentState.Planned, observedAt)
                committedRecords.set(intent.intentId, record)
                return { record, deduplicated: false }
              }),
          }),
          Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
          Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
          Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
          Effect.provideService(ValuationStore, {} as ValuationStoreShape),
          Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
          Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
          Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
          Effect.provideService(WriterFence, {} as WriterFenceService),
          Effect.provideService(CandidateObservationStore, {
            record: () => Effect.void,
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
          }),
          provideJevTestServices,
          Effect.provide(TestClock.layer()),
        ),
      )
      expect(reads).toBe(1)
      expect(finalized).toBe(1)
      expect(reconciliations).toBe(2)
      expect(committedIntents).toBe(1)
      expect(close.createdAt).toBe(utcInstantFromEpochMillis(startedAt + expectedCloseMs))
      expect(close.dispatchable).toBeTrue()
      expect(close.bindings.executionMarketData).toMatchObject({
        schemaVersion: 'bayn.reconciled-position-liquidation-binding.v1',
        positionsObservedAt: close.createdAt,
      })
    },
  )

  test('keeps a rejected execution close intent recoverable while reconciliation still shows an open position', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '5'.repeat(64),
      mutationId: '6'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: '7'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'paper-close-rejected-request',
      responseStatus: 422,
      responseContentHash: '8'.repeat(64),
      occurredAt: observedAt,
    }
    const restrictions: string[] = []
    const step = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected),
      rejected,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      {
        ...fixture.input,
        mutationPhase: 'CLOSE',
        executionCycleCloseSubmitCutoffAt: closeExpiresAt,
        executionCycleCloseExpiresAt: closeExpiresAt,
      },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [],
      { ...fixture.document, submissionCutoffAt: closeExpiresAt, expiresAt: closeExpiresAt },
      [
        {
          schemaVersion: 'bayn.position.v2',
          costBasisMicros: '100000000',
          accountId,
          symbol: fixture.intent.symbol,
          quantityAtoms: '1000000000',
          averageEntryPriceMicros: '100000000',
          marketPriceMicros: '100000000',
          marketValueMicros: '100000000',
          unrealizedPnlMicros: '0',
          observedAt,
        },
      ],
    )

    expect(step).toEqual({ _tag: 'Wait', observedAt, waitReason: 'intent-unsuccessful' })
    expect(restrictions).toHaveLength(1)
  })

  test('continues to a later close intent while capping fresh submission before close expiry', async () => {
    const fixture = await executionLifecycleFixture((policy) => ({
      ...policy,
      maxBrokerStateAgeMs: 3_600_000,
      maxMarketDataAgeMs: 3_600_000,
    }))
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const closeSubmitCutoffAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 30_000)
    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const positions = ['AMD', fixture.intent.symbol].map((symbol) => ({
      schemaVersion: 'bayn.position.v2' as const,
      costBasisMicros: '100000000',
      accountId,
      symbol,
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }))
    const currentReconciliation = reconciliationResultAt(observedAt, 0, 0, positions)
    const close = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return (yield* prepareClosingExecutionCycleDecision({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          entryDocument: fixture.document,
          reconcile: Effect.succeed(currentReconciliation),
          closeExpiresAt,
        })).document
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
    const closeIntents = await Promise.all(
      close.targetPlan.intentTargets.map(async (target, index) => {
        const risk = close.deltaRisk[index]
        if (risk === undefined) throw new Error('PAPER close fixture risk binding is missing')
        return Effect.runPromise(
          planExecutionIntent(
            {
              schemaVersion: 'bayn.intent-plan.v3',
              ...target,
              notionalLimitMicros: risk.notionalLimitMicros,
              limitPriceMicros: risk.limitPriceMicros,
              ...(risk.protection === undefined ? {} : { protection: risk.protection }),
              createdAt: close.createdAt,
            },
            {
              authority: {
                schemaVersion: 'bayn.paper-authority.v1',
                generationHash,
                maximum: Authority.Execution,
                effective: Authority.Execution,
                kill: KillState.Clear,
                version: 1,
                updatedAt: close.createdAt,
              },
            },
          ),
        )
      }),
    )
    const firstIntent = closeIntents[0]
    const secondIntent = closeIntents[1]
    if (firstIntent === undefined || secondIntent === undefined) {
      return expect.unreachable('multi-symbol close fixture requires two intents')
    }
    expect(close.orderedIntentIds).toHaveLength(2)

    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '9'.repeat(64),
      mutationId: 'a'.repeat(64),
      intentId: firstIntent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: 'b'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'multi-symbol-close-rejected-request',
      responseStatus: 422,
      responseContentHash: 'c'.repeat(64),
      occurredAt: observedAt,
    }
    const records = new Map<string, StoredIntent>([
      [firstIntent.intentId, storedIntent(firstIntent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected)],
      [
        secondIntent.intentId,
        {
          ...storedIntent(
            { ...secondIntent, riskDecisionId: close.deltaRisk[1]?.evaluation.decision.decisionId },
            IntentState.Approved,
            close.createdAt,
          ),
          decision: close.deltaRisk[1]?.evaluation.decision,
        },
      ],
    ])
    const latestSubmits = new Map<string, MutationEvent | undefined>([
      [firstIntent.intentId, rejected],
      [secondIntent.intentId, undefined],
    ])
    const restrictions: string[] = []
    const step = await prepareStoredExecutionStep(
      fixture,
      records.get(firstIntent.intentId) as StoredIntent,
      rejected,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      {
        ...fixture.input,
        mutationPhase: 'CLOSE',
        executionCycleCloseSubmitCutoffAt: closeSubmitCutoffAt,
        executionCycleCloseExpiresAt: closeExpiresAt,
      },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      records,
      latestSubmits,
      [],
      close,
      positions,
    )

    expect(step).toMatchObject({
      _tag: 'Execute',
      action: 'SUBMIT',
      intentId: secondIntent.intentId,
      observedAt,
      submitExpiresAt: closeSubmitCutoffAt,
    })
    expect(restrictions).toHaveLength(1)
  })

  test.each([Authority.Execution, Authority.Observe])(
    'blocks a rejected Jev entry under %s authority',
    async (effectiveAuthority) => {
      const fixture = await executionLifecycleFixture()
      const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1000)
      const record = storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected)
      const restrictions: string[] = []
      const step = await prepareStoredExecutionStep(
        fixture,
        record,
        undefined,
        observedAt,
        0,
        (reason) => restrictions.push(reason),
        fixture.input,
        undefined,
        true,
        fixture.policy,
        fixture.preparation,
        undefined,
        undefined,
        [],
        fixture.document,
        [],
        effectiveAuthority,
      )
      expect(step).toEqual({ _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt })
      expect(restrictions).toHaveLength(1)
    },
  )

  test('retains a canceled partial-fill PAPER entry during a calendar outage without restricting authority', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Canceled)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '5'.repeat(64),
      mutationId: '6'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '7'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'single-partial-canceled-order',
      occurredAt: observedAt,
    }
    const partialOrder: Order = {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: accepted.brokerOrderId ?? 'single-partial-canceled-order',
      clientOrderId: fixture.intent.clientOrderId,
      intentId: fixture.intent.intentId,
      symbol: fixture.intent.symbol,
      side: fixture.intent.side,
      orderType: fixture.intent.orderType,
      timeInForce: fixture.intent.timeInForce,
      quantityAtoms: fixture.intent.quantityAtoms,
      filledQuantityAtoms: '1000',
      status: OrderStatus.Canceled,
      observedAt,
    }
    const restrictions: string[] = []

    const step = await prepareStoredExecutionStep(
      fixture,
      record,
      accepted,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      fixture.input,
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [partialOrder],
    )

    expect(step).toEqual({ _tag: 'Wait', observedAt, waitReason: 'reconciliation-not-later' })
    expect(restrictions).toHaveLength(0)
    expect(executionCycleHasFilledIntent({ intents: [record.intent], orders: [partialOrder] })).toBe(true)

    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 120_000)
    const closeRestrictions: string[] = []
    const closeStep = await prepareStoredExecutionStep(
      fixture,
      record,
      accepted,
      observedAt,
      0,
      (reason) => closeRestrictions.push(reason),
      {
        ...fixture.input,
        mutationPhase: 'CLOSE',
        executionCycleCloseSubmitCutoffAt: closeExpiresAt,
        executionCycleCloseExpiresAt: closeExpiresAt,
      },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [partialOrder],
      { ...fixture.document, submissionCutoffAt: closeExpiresAt, expiresAt: closeExpiresAt },
    )

    expect(closeStep).toEqual({ _tag: 'Wait', observedAt, waitReason: 'intent-unsuccessful' })
    expect(closeRestrictions).toHaveLength(1)
  })

  test('completes a filled PAPER cycle after a later exact post-cutoff reconciliation', async () => {
    const fixture = await executionLifecycleFixture()
    const terminalAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const reconciledLaterAt = utcInstantFromEpochMillis(Date.parse(terminalAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Terminal, terminalAt, TerminalOutcome.Filled)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '7'.repeat(64),
      mutationId: '8'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '9'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'filled-past-cutoff',
      occurredAt: terminalAt,
    }

    const step = await prepareStoredExecutionStep(fixture, record, accepted, reconciledLaterAt)

    expect(step).toEqual({ _tag: 'Complete', observedAt: reconciledLaterAt })
    const completion = Result.getOrThrow(decideCompletion(fixture.boundCycle, CycleState.Completed, reconciledLaterAt))
    if (completion._tag !== 'VerifyDecision') return expect.unreachable('PAPER completion must verify')
    expect(Result.isFailure(validateCompletionDocument(completion, [fixture.document]))).toBe(true)
    expect(Result.isSuccess(validateCompletionDocument(completion, [fixture.document], true))).toBe(true)
  })

  test('derives the autonomous cycle protocol identity from the current strategy provenance', () => {
    const prepared = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: currentIntradayRuntime,
    })

    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.strategyProtocolHash).toBe(
        makeStrategyProtocolHash(currentIntradayRuntime.provenance.strategy),
      )
    }
  })

  test('admits only the source-controlled Jev execution model at autonomous startup', () => {
    const protocol = fixtureProtocol
    const definition = makeJevDefinition(protocol)
    const strategy = {
      definition,
      provenance: {
        ...fixtureRuntime.provenance,
        strategy: {
          name: definition.name,
          behaviorHash: jevBehaviorHash,
          parameterHash: Result.getOrThrow(canonicalHashV1Result(definition.parameters)),
          parameterSchemaVersion: definition.parameters.schemaVersion,
        },
      },
    }

    const prepared = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy,
    })

    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.executionModel.schemaVersion).toBe('bayn.execution-model.v6')
      expect(prepared.success.executionPolicy).toMatchObject({
        schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
        warmupAfterOpenMs: 0,
        submissionCutoffBeforeCloseMs: 300_000,
      })
    }

    const customDefinition = makeJevDefinition({
      ...protocol,
      holdingMinutes: { ...protocol.holdingMinutes, CRYPTO: 30 },
    })
    const customProtocol = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: {
        definition: customDefinition,
        provenance: {
          ...fixtureRuntime.provenance,
          strategy: {
            name: customDefinition.name,
            behaviorHash: jevBehaviorHash,
            parameterHash: Result.getOrThrow(canonicalHashV1Result(customDefinition.parameters)),
            parameterSchemaVersion: customDefinition.parameters.schemaVersion,
          },
        },
      },
    })
    expect(Result.isFailure(customProtocol)).toBe(true)
    if (Result.isFailure(customProtocol)) {
      expect(customProtocol.failure.message).toBe('Jev autonomous execution requires the source-controlled protocol')
    }
  })

  test('rejects retired momentum runtime identity even with its valid protocol and provenance', () => {
    const protocol = Result.getOrThrow(decodeIntradayMomentumProtocol(defaultIntradayMomentumProtocolDocument))
    const definition = makeIntradayMomentumDefinition(protocol)
    const prepared = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: {
        definition: definition as unknown as import('./strategy').StrategyRuntime['definition'],
        provenance: {
          ...fixtureRuntime.provenance,
          strategy: {
            name: definition.name,
            behaviorHash: intradayMomentumBehaviorHash,
            parameterHash: Result.getOrThrow(canonicalHashV1Result(protocol)),
            parameterSchemaVersion: protocol.schemaVersion,
          },
        },
      },
    })
    expect(Result.isFailure(prepared)).toBe(true)
    if (Result.isFailure(prepared)) {
      expect(prepared.failure.message).toBe('autonomous execution requires the active Jev strategy')
    }
  })

  test.each([
    'maxOrderNotionalMicros',
    'maxSymbolExposureMicros',
    'maxGrossExposureMicros',
    'maxNetExposureMicros',
  ] as const)('plans an approved Jev entry at the binding %s cap', async (limit) => {
    const baseline = await executionLifecycleFixture()
    const cap = baseline.document.targetPlan.requiredReferenceBuyNotionalMicros
    const bounded = await executionLifecycleFixture((policy) => ({ ...policy, [limit]: cap }))
    expect(bounded.document.dispatchable).toBe(true)
    expect(bounded.risk.evaluation.decision.outcome).toBe(RiskOutcome.Approved)
    if (limit === 'maxOrderNotionalMicros') {
      expect(BigInt(bounded.intent.quantityAtoms)).toBeLessThan(BigInt(baseline.intent.quantityAtoms))
      expect(BigInt(bounded.risk.notionalLimitMicros)).toBeLessThanOrEqual(BigInt(cap))
    } else {
      expect(BigInt(bounded.intent.quantityAtoms)).toBeGreaterThan(0n)
      expect(BigInt(bounded.intent.quantityAtoms)).toBeLessThanOrEqual(BigInt(baseline.intent.quantityAtoms))
    }
    expect(bounded.policy[limit]).toBe(cap)
  })

  const buildEntryWithHeadroom = async (
    options: {
      readonly inferenceMs?: number
      readonly refreshMs?: number
      readonly refreshedAgeMs?: number
      readonly initialAgeMs?: number
      readonly pricingReadDelayMs?: number
      readonly brokerMaximumAgeMs?: number
      readonly admissionRemainingMs?: number
      readonly cycleCreatedAt?: string
      readonly entryAction?: 'enter' | 'wait'
      readonly postInferenceReconcileMs?: number
      readonly decisionFinalizationHeadroomMs?: number
      readonly transform?: (result: ReconciliationPassResult) => ReconciliationPassResult
    } = {},
  ) => {
    const fixture = await executionLifecycleFixture()
    const policy = {
      ...fixture.policy,
      maxBrokerStateAgeMs: options.brokerMaximumAgeMs ?? fixture.policy.maxBrokerStateAgeMs,
    }
    const events: string[] = []
    const snapshotRequests: IntradaySnapshotRequest[] = []
    let refreshes = 0
    let refreshed: ReconciliationPassResult | undefined
    let reconciliationReads = 0
    const testStartedAt =
      options.admissionRemainingMs === undefined
        ? Date.parse(evaluatedAt)
        : Date.parse(cycle.window.submissionCutoffAt) - options.admissionRemainingMs
    const initial = reconciliationResultAt(utcInstantFromEpochMillis(testStartedAt - (options.initialAgeMs ?? 30_000)))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(testStartedAt)
        const cache = yield* reconciliationForPreparation(
          initial,
          Effect.gen(function* () {
            refreshes += 1
            events.push('refresh-start')
            const startedAt = yield* Clock.currentTimeMillis
            yield* TestClock.adjust(options.refreshMs ?? 1_000)
            const facts = reconciliationResultAt(utcInstantFromEpochMillis(startedAt - (options.refreshedAgeMs ?? 0)))
            refreshed = options.transform?.(facts) ?? {
              ...facts,
              riskContext: { ...facts.riskContext, dailyTradedNotionalMicros: '1000000' },
            }
            events.push('refresh-committed')
            return refreshed
          }),
          Effect.sync(() => {
            const authority = refreshed?.riskContext.authority ?? initial.riskContext.authority
            if (authority === null) throw new Error('fixture authority missing')
            return authority
          }),
          policy.maxBrokerStateAgeMs,
        )
        const document = yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle:
            options.admissionRemainingMs === undefined && options.cycleCreatedAt === undefined
              ? cycle
              : {
                  ...cycle,
                  createdAt: options.cycleCreatedAt ?? utcInstantFromEpochMillis(testStartedAt - 1_000),
                  updatedAt: options.cycleCreatedAt ?? utcInstantFromEpochMillis(testStartedAt - 1_000),
                },
          executionModel: fixture.preparation.executionModel,
          policy,
          strategy: fixtureRuntime,
          reconcile: Effect.gen(function* () {
            const facts = yield* cache.read
            reconciliationReads += 1
            if (reconciliationReads > 1 && options.postInferenceReconcileMs !== undefined)
              yield* TestClock.adjust(options.postInferenceReconcileMs)
            return facts
          }),
          ...(options.decisionFinalizationHeadroomMs === undefined
            ? {}
            : { decisionFinalizationHeadroomMs: options.decisionFinalizationHeadroomMs }),
          reconcileForPricing: (minimumRemainingMs) =>
            Effect.gen(function* () {
              const facts = yield* cache.readForPricing(minimumRemainingMs)
              yield* TestClock.adjust(options.pricingReadDelayMs ?? 0)
              return facts
            }),
          intradayMarketData: {
            ...fixture.input.intradayMarketData,
            loadSnapshot: (query) =>
              Effect.gen(function* () {
                events.push(query.purpose === IntradaySnapshotPurpose.EntryPricing ? 'pricing' : 'signal')
                snapshotRequests.push({ ...query, archiveWatermarks: [] })
                return yield* fixture.input.intradayMarketData.loadSnapshot(query)
              }),
          },
        }).pipe(
          Effect.provideService(JevBatchStore, {
            pending: () => Effect.succeed([]),
            read: () => Effect.die('entry fixture must not reread a batch'),
            finish: () => Effect.die('entry fixture uses a committed batch'),
            begin: (plan) =>
              Effect.gen(function* () {
                yield* TestClock.adjust(options.inferenceMs ?? 1_000)
                events.push('inference-committed')
                return {
                  plan,
                  dispatches: [],
                  result: nativeJevBatchResult(plan, yield* currentUtcInstant, (symbol) =>
                    symbol === 'NVDA' ? (options.entryAction ?? 'enter') : 'wait',
                  ),
                }
              }),
          }),
        )
        // Intent preparation must reuse the new cut instead of paying for another reconciliation after pricing.
        yield* TestClock.adjust(2_000)
        expect(yield* cache.read).toBe(refreshed ?? initial)
        return document
      }).pipe((program) => provideDecisionServices(program, calendarRead([])), Effect.provide(TestClock.layer())),
    )
    return { exit, events, snapshotRequests, refreshes, initial, refreshed, reconciliationReads }
  }

  test('Jev pricing follows committed refresh and uses current risk with immutable model evidence', async () => {
    const result = await buildEntryWithHeadroom({ brokerMaximumAgeMs: 40_000 })
    if (Exit.isFailure(result.exit)) throw Cause.squash(result.exit.cause)
    const document = result.exit.value
    expect(result.events).toEqual(['signal', 'inference-committed', 'refresh-start', 'refresh-committed', 'pricing'])
    expect(result.refreshes).toBe(1)
    expect(result.snapshotRequests[1]?.observedAt).toBe('2020-05-01T16:45:04.000Z')
    expect(document.strategyDecision?.schemaVersion).toBe('bayn.jev-entry-target.v7')
    if (document.strategyDecision?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('expected Jev entry')
    expect(
      Result.getOrThrow(canonicalHashV1Result(document.strategyDecision.evidence.observation.portfolio.brokerState)),
    ).toBe(Result.getOrThrow(canonicalHashV1Result(result.initial.brokerState)))
    expect(document.deltaRisk[0]?.facts?.state.account).toEqual(result.refreshed?.brokerState.account)
    expect(document.deltaRisk[0]?.facts?.state.dailyTradedNotionalMicros).toBe('1000000')
    expect(document.deltaRisk[0]?.facts?.state.entryQuote).toEqual({
      eventAt: '2020-05-01T16:45:03.000Z',
      maximumAgeMs: 10_000,
    })
    expect(document.deltaRisk[0]?.evaluation.decision.expiresAt).toBe('2020-05-01T16:45:13.000Z')
  })

  test.each([2_000, 3_000])(
    'Jev abstention completing after %ims cannot construct a decision at or past its original admission cutoff',
    async (inferenceMs) => {
      const result = await buildEntryWithHeadroom({
        entryAction: 'wait',
        initialAgeMs: 0,
        admissionRemainingMs: 2_000,
        inferenceMs,
      })
      expect(Exit.isFailure(result.exit)).toBe(true)
      if (Exit.isSuccess(result.exit)) throw new Error('expired admission must not produce a decision')
      expect(Option.getOrThrow(Cause.findErrorOption(result.exit.cause))).toMatchObject({
        _tag: 'ObserveDecisionAwaitingSignal',
      })
      expect(result.events).not.toContain('pricing')
      expect(result.refreshes).toBe(0)
    },
  )

  test.each([5_000, 10_000])(
    'Jev equity abstention uses the unused entry lease with %ims of finalization headroom',
    async (decisionFinalizationHeadroomMs) => {
      const result = await buildEntryWithHeadroom({
        entryAction: 'wait',
        initialAgeMs: 0,
        cycleCreatedAt: utcInstantFromEpochMillis(Date.parse(evaluatedAt) - 50_000),
        inferenceMs: 1_000,
        decisionFinalizationHeadroomMs,
      })
      if (decisionFinalizationHeadroomMs === 5_000) {
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isSuccess(result.exit)) throw new Error('entry lease still permits another observation')
        expect(Option.getOrThrow(Cause.findErrorOption(result.exit.cause))).toMatchObject({
          _tag: 'ObserveDecisionAwaitingSignal',
          readiness: { reason: DecisionReadinessReason.NoEligibleCandidate },
        })
      } else {
        if (Exit.isFailure(result.exit)) throw Cause.squash(result.exit.cause)
        expect(result.exit.value.targetPlan.status).toBe(TargetPlanStatus.NoTrade)
        expect(result.exit.value.orderedIntentIds).toEqual([])
        expect(result.reconciliationReads).toBe(2)
      }
      expect(result.events).not.toContain('pricing')
      expect(result.refreshes).toBe(0)
    },
  )

  test.each([4_000, 4_001])(
    'Jev abstention reconciliation lasting %ims cannot outlive the admission with still-current inference',
    async (postInferenceReconcileMs) => {
      const result = await buildEntryWithHeadroom({
        entryAction: 'wait',
        initialAgeMs: 0,
        admissionRemainingMs: 5_000,
        inferenceMs: 1_000,
        decisionFinalizationHeadroomMs: 5_000,
        postInferenceReconcileMs,
      })
      expect(Exit.isFailure(result.exit)).toBe(true)
      if (Exit.isSuccess(result.exit)) throw new Error('expired admission must not produce a decision')
      expect(Option.getOrThrow(Cause.findErrorOption(result.exit.cause))).toMatchObject({
        _tag: 'ObserveDecisionAwaitingSignal',
        readiness: { reason: DecisionReadinessReason.InferenceUnavailable },
      })
      expect(result.reconciliationReads).toBe(2)
      expect(result.events).not.toContain('pricing')
    },
  )

  test.each([22_000, 27_000, 35_000])(
    'Jev binds timely inference with broker-valid facts %ims old without a slow reconciliation refresh',
    async (initialAgeMs) => {
      const result = await buildEntryWithHeadroom({
        initialAgeMs,
        inferenceMs: 3_000,
        refreshMs: 9_642,
        brokerMaximumAgeMs: 300_000,
      })
      if (Exit.isFailure(result.exit)) throw Cause.squash(result.exit.cause)
      expect(result.events).toEqual(['signal', 'inference-committed', 'pricing'])
      expect(result.refreshes).toBe(0)
      const decision = result.exit.value.strategyDecision
      if (decision?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('expected Jev entry')
      expect(decision.selectedSymbols).toEqual(['NVDA'])
      expect(result.exit.value.deltaRisk[0]?.facts?.state.account).toEqual(result.initial.brokerState.account)
    },
  )

  test('Jev abstention does not refresh broker-valid facts after the reconciliation cadence expires', async () => {
    const result = await buildEntryWithHeadroom({
      entryAction: 'wait',
      initialAgeMs: 35_000,
      inferenceMs: 3_000,
      refreshMs: 9_642,
      brokerMaximumAgeMs: 300_000,
      decisionFinalizationHeadroomMs: 60_000,
    })
    if (Exit.isFailure(result.exit)) throw Cause.squash(result.exit.cause)
    expect(result.exit.value.targetPlan.status).toBe(TargetPlanStatus.NoTrade)
    expect(result.exit.value.orderedIntentIds).toEqual([])
    expect(result.events).toEqual(['signal', 'inference-committed'])
    expect(result.refreshes).toBe(0)
  })

  test.each([
    {
      name: 'refresh exhausts the existing model deadline',
      inferenceMs: 7_000,
      refreshMs: 3_000,
      brokerMaximumAgeMs: 40_000,
    },
    {
      name: 'refresh commit consumes the remaining broker-risk headroom',
      refreshedAgeMs: 19_000,
      refreshMs: 1_000,
      brokerMaximumAgeMs: 30_000,
    },
  ])('Jev waits before selecting a quote when $name', async (options) => {
    const result = await buildEntryWithHeadroom(options)
    expect(Exit.isFailure(result.exit)).toBe(true)
    if (Exit.isSuccess(result.exit)) throw new Error('expired evidence must not produce a bindable decision')
    expect(Option.getOrThrow(Cause.findErrorOption(result.exit.cause))).toMatchObject({
      _tag: 'ObserveDecisionAwaitingSignal',
      readiness: { reason: DecisionReadinessReason.InferenceUnavailable },
    })
    expect(result.refreshes).toBe(1)
    expect(result.snapshotRequests).toHaveLength(1)
    expect(result.events).not.toContain('pricing')
  })

  test('Jev rechecks cached headroom at the pricing clock before selecting a quote', async () => {
    const result = await buildEntryWithHeadroom({
      initialAgeMs: 19_999,
      inferenceMs: 0,
      pricingReadDelayMs: 1,
      brokerMaximumAgeMs: 30_000,
    })
    expect(Exit.isFailure(result.exit)).toBe(true)
    if (Exit.isSuccess(result.exit)) throw new Error('exhausted cached headroom must not produce a bindable decision')
    expect(Option.getOrThrow(Cause.findErrorOption(result.exit.cause))).toMatchObject({
      _tag: 'ObserveDecisionAwaitingSignal',
      readiness: { reason: DecisionReadinessReason.InferenceUnavailable },
    })
    expect(result.refreshes).toBe(0)
    expect(result.events).not.toContain('pricing')
  })

  test.each(['holding', 'unknown-mutation', 'generation'] as const)(
    'Jev rejects refreshed %s facts before selecting a quote',
    async (change) => {
      const result = await buildEntryWithHeadroom({
        brokerMaximumAgeMs: 40_000,
        transform: (facts) => {
          if (change === 'holding')
            return reconciliationResultAt(facts.brokerState.account.observedAt, 0, 0, [
              {
                schemaVersion: 'bayn.position.v2',
                costBasisMicros: '10000000',
                accountId,
                symbol: 'NVDA',
                quantityAtoms: '1000000000',
                averageEntryPriceMicros: '10000000',
                marketPriceMicros: '10000000',
                marketValueMicros: '10000000',
                unrealizedPnlMicros: '0',
                observedAt: facts.brokerState.account.observedAt,
              },
            ])
          if (change === 'unknown-mutation')
            return { ...facts, riskContext: { ...facts.riskContext, unknownMutationCount: 1 } }
          const authority = facts.riskContext.authority
          if (authority === null) throw new Error('fixture requires authority')
          return {
            ...facts,
            riskContext: { ...facts.riskContext, authority: { ...authority, generationHash: 'f'.repeat(64) } },
          }
        },
      })
      expect(Exit.isFailure(result.exit)).toBe(true)
      if (Exit.isSuccess(result.exit)) throw new Error('changed portfolio must not produce a bindable decision')
      expect(Option.getOrThrow(Cause.findErrorOption(result.exit.cause))).toMatchObject({
        _tag: change === 'generation' ? 'ObserveDecisionCompositionFailure' : 'OperationalError',
      })
      expect(result.events).not.toContain('pricing')
    },
  )

  test.each([1, 1_000, 3_000, 30_000])(
    'the recovery driver prices an entry with a %sms reconciliation cadence',
    async (cadenceMs) => {
      const fixture = await executionLifecycleFixture()
      const services = makeExactReconciliationServices(Authority.Execution)
      const input = { ...fixture.input, reconciliationIntervalMs: cadenceMs, reconciliationPassTimeoutMs: cadenceMs }
      const builder = mutationDecisionBuilder(input, fixture.preparation, fixture.policy)
      let document: CycleDecisionDocument | undefined
      let pricingReads = 0
      const forbidden = () => Effect.die('pricing preparation test must not bind or submit')
      const cycleStore: CycleStoreShape = {
        readOldestUnfinished: () => Effect.succeed(Option.some(cycle)),
        acquire: forbidden,
        read: forbidden,
        readAuthoritySlot: forbidden,
        readDecisionDocument: forbidden,
        activate: forbidden,
        bindDecision: forbidden,
        finish: forbidden,
        block: forbidden,
      }
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          const driver = yield* Effect.fromResult(
            makeRecoveryFirstCycleDriver(
              input,
              { cycleBindingId: cycle.identity.qualificationRunId, recordPass: () => Effect.void },
              fixture.preparation,
              fixture.policy,
              { _tag: 'Mutation', executionProgram: input.executionProgram },
              (currentCycle, reconcile, reconcileForPricing) =>
                Effect.gen(function* () {
                  if (reconcileForPricing === undefined)
                    return yield* Effect.die('driver omitted pricing reconciliation')
                  document = yield* builder(currentCycle, reconcile, (minimumRemainingMs) =>
                    Effect.gen(function* () {
                      pricingReads += 1
                      expect(minimumRemainingMs).toBe(fixtureProtocol.maximumQuoteAgeMs)
                      return yield* reconcileForPricing(minimumRemainingMs)
                    }),
                  )
                  // Stop at the tested preparation boundary; no durable decision or broker mutation belongs in this test.
                  return yield* new CycleDecisionBuildError({
                    failure: 'not-ready',
                    message: 'prepared entry verified',
                  })
                }),
              'mutation autonomous cycle loop',
            ),
          ).pipe(Effect.flatten)
          return yield* driver.advance
        }).pipe(
          Effect.provideService(BrokerRead, { ...services.brokerRead, marketCalendar: calendarRead([]) }),
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(BrokerEventStore, services.executionStore),
          Effect.provideService(FillAccountingStore, services.executionStore),
          Effect.provideService(ValuationStore, services.executionStore),
          Effect.provideService(ReconciliationStore, services.executionStore),
          Effect.provideService(AuthorityGenerationStore, services.executionStore),
          Effect.provideService(AuthorityRestrictionStore, services.executionStore),
          Effect.provideService(IntentStore, {
            protectionForCycle: () => Effect.succeed([]),
            beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
            commit: forbidden,
            read: forbidden,
          }),
          Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
          Effect.provideService(WriterFence, services.writerFence),
          Effect.provideService(CandidateObservationStore, {
            record: () => Effect.void,
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
          }),
          provideJevTestServices,
          Effect.provide(TestClock.layer()),
        ),
      )
      expect(result.observation.result).toBe('SUCCESS')
      expect(document?.dispatchable).toBe(true)
      expect(document?.targetPlan.status).toBe(TargetPlanStatus.Planned)
      expect(pricingReads).toBe(1)
    },
  )

  test('binds a native Jev entry to its full signal batch and independent execution pricing', async () => {
    const fixture = await executionLifecycleFixture()
    expect(fixture.snapshotRequests).toHaveLength(2)
    expect(fixture.snapshotRequests[0]).toMatchObject({ symbols: equityMarketProfile.universe })
    expect(fixture.snapshotRequests[1]).toMatchObject({
      symbols: ['NVDA'],
      purpose: IntradaySnapshotPurpose.EntryPricing,
    })
    expect(fixture.document).toMatchObject({
      mode: 'PAPER',
      dispatchable: true,
      bindings: {
        strategyName: 'jev',
        accountId,
        cycleId: cycle.identity.cycleId,
        decisionMarketData: { symbols: equityMarketProfile.universe },
        executionMarketData: { symbols: ['NVDA'], purpose: IntradaySnapshotPurpose.EntryPricing },
      },
      strategyDecision: { schemaVersion: 'bayn.jev-entry-target.v7', selectedSymbols: ['NVDA'] },
      targetPlan: { status: TargetPlanStatus.Planned },
    })
    expect(fixture.document.orderedIntentIds).toHaveLength(1)
    expect(fixture.intents[0]).toMatchObject({
      symbol: 'NVDA',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
    })
    expect(fixture.risk.evaluation.decision.outcome).toBe(RiskOutcome.Approved)
    const { contentHash: _hash, ...material } = fixture.document
    const forged = makeExecutionDecisionDocument({
      ...material,
      deltaRisk: material.deltaRisk.map((risk) => ({
        ...risk,
        ...(risk.facts === undefined
          ? {}
          : {
              facts: {
                ...risk.facts,
                state: { ...risk.facts.state, closeOnly: true, closeOnlyExpiresAt: material.expiresAt },
              },
            }),
      })),
    })
    expect(Result.isFailure(forged)).toBe(true)
  })

  test.each(['AMD', 'TSLA'])('rejects a fresh Jev entry while a reconciled %s holding exists', async (symbol) => {
    const fixture = await executionLifecycleFixture()
    const position: Position = {
      schemaVersion: 'bayn.position.v2',
      costBasisMicros: '10000000',
      accountId,
      symbol,
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '10000000',
      marketPriceMicros: '10000000',
      marketValueMicros: '10000000',
      unrealizedPnlMicros: '0',
      observedAt: evaluatedAt,
    }
    let snapshotLoads = 0
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixture.preparation.executionModel,
          policy: fixture.policy,
          strategy: fixtureRuntime,
          reconcile: Effect.succeed(reconciliationResultAt(evaluatedAt, 0, 0, [position])),
          intradayMarketData: {
            ...fixture.input.intradayMarketData,
            loadSnapshot: () =>
              Effect.sync(() => {
                snapshotLoads += 1
              }).pipe(Effect.andThen(Effect.die('Occupied account must not start an entry observation'))),
          },
        })
      }).pipe((program) => provideDecisionServices(program, calendarRead([])), Effect.provide(TestClock.layer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('entry requires a reconciled flat account')
    expect(snapshotLoads).toBe(0)
  })

  test('binds a native session close to its exact liquidation minute and execution session', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.boundCycle.window.submissionCutoffAt) + 1000)
    const position: Position = {
      schemaVersion: 'bayn.position.v2',
      costBasisMicros: '10000000',
      accountId,
      symbol: fixture.intent.symbol,
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '10000000',
      marketPriceMicros: '10000000',
      marketValueMicros: '10000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const close = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return (yield* prepareClosingExecutionCycleDecision({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          entryDocument: fixture.document,
          reconcile: Effect.succeed(reconciliationResultAt(observedAt, 0, 0, [position])),
          closeExpiresAt: fixture.boundCycle.window.executionCloseAt,
        })).document
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(close.dispatchable).toBe(true)
    expect(close.bindings.executionMarketData).toMatchObject({
      schemaVersion: 'bayn.execution-market-data-binding.v3',
      purpose: IntradaySnapshotPurpose.Liquidation,
      rangeStartAt: '2020-05-01T20:24:00.000Z',
      rangeEndAt: '2020-05-01T20:25:00.000Z',
      observedAt,
    })
    const { contentHash: _hash, ...material } = close
    const { executionSession: _session, ...withoutSession } = material
    for (const altered of [
      { ...material, createdAt: utcInstantFromEpochMillis(Date.parse(observedAt) + 1000) },
      { ...material, createdAt: utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000) },
      withoutSession,
    ]) {
      expect(
        Result.isFailure(
          decodeExecutionDecisionDocument({
            ...altered,
            contentHash: Result.getOrThrow(canonicalHashV1Result(altered)),
          }),
        ),
      ).toBe(true)
    }
  })

  test('waits without inference when every native Jev candidate lacks usable evidence', async () => {
    const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, fixtureRuntime))
    let inferenceBatches = 0
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixtureProtocol.executionModel,
          policy,
          strategy: fixtureRuntime,
          reconcile: Effect.succeed(reconciliationResultAt(evaluatedAt)),
          intradayMarketData: {
            check: Effect.void,
            verifyReference: fixtureStreamingReference,
            loadSnapshot: (query) =>
              Effect.suspend(() => {
                const raw = makeIntradayMomentumTestSnapshot(
                  fixtureProtocol,
                  { ...query, archiveWatermarks: [] },
                  {},
                  10,
                )
                const { cut } = streamingFixtureFromRaw(raw, query)
                return Effect.fromResult(
                  constructStreamingSnapshot(
                    {
                      ...cut,
                      projection: {
                        ...cut.projection,
                        quoteHistory: new Map([...cut.projection.quoteHistory].filter(([symbol]) => symbol === 'SPY')),
                        tradeHistory: new Map([...cut.projection.tradeHistory].filter(([symbol]) => symbol === 'SPY')),
                      },
                    },
                    query,
                  ),
                ).pipe(
                  Effect.mapError((cause) =>
                    operationalError({
                      component: 'market-data',
                      operation: 'snapshot',
                      message: 'Streaming snapshot is unavailable',
                      cause,
                    }),
                  ),
                )
              }),
          },
        })
      }).pipe(
        (program) =>
          provideDecisionServices(
            program.pipe(
              Effect.provideService(JevBatchStore, {
                read: () => Effect.die('no batch should be read'),
                pending: () => Effect.succeed([]),
                begin: () =>
                  Effect.sync(() => {
                    inferenceBatches += 1
                  }).pipe(Effect.andThen(Effect.die('excluded batch must not infer'))),
                finish: () => Effect.die('no batch should be finished'),
              }),
            ),
            calendarRead([]),
          ),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('ObserveDecisionAwaitingSignal')
    expect(inferenceBatches).toBe(0)
  })

  test('a previously observed Jev entry window reports when fresh evidence becomes eligible', async () => {
    const fixture = await executionLifecycleFixture()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixture.preparation.executionModel,
          policy: fixture.policy,
          strategy: fixtureRuntime,
          reconcile: Effect.succeed(reconciliationResultAt(evaluatedAt)),
          intradayMarketData: fixture.input.intradayMarketData,
        }).pipe(Effect.result)
      }).pipe(
        Effect.provideService(CandidateObservationStore, {
          latestJevWindowEnd: () => Effect.succeed(Option.some('2020-05-01T16:45:00.000Z')),
          record: () => Effect.die('Same-window retry must not record a new observation'),
        }),
        (program) => provideDecisionServices(program, calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: 'ObserveDecisionAwaitingSignal',
        readiness: { reason: DecisionReadinessReason.SignalWindowObserved, availableAt: '2020-05-01T16:46:02.000Z' },
      })
  })

  test('decodes a versioned quote-bound LIMIT/IOC policy for intraday execution', async () => {
    const policy = await Effect.runPromise(loadExecutionRiskPolicy(accountId, [...fixtureProtocol.universe].reverse()))

    expect(policy).toMatchObject({
      schemaVersion: 'bayn.execution-risk-policy.v4',
      accountId,
      allowedSymbols: fixtureProtocol.universe,
      allowedOrderTypes: [OrderType.Limit, OrderType.StopLimit],
      allowedTimeInForce: [TimeInForce.Day, TimeInForce.GoodUntilCanceled, TimeInForce.ImmediateOrCancel],
    })
  })

  test('keeps startup and one externally driven pass explicit at separate composition boundaries', async () => {
    const unused = Effect.die(new Error('missing-publication loop must not use this capability'))
    const authority = reconciliationResult().riskContext.authority
    if (authority === null) return expect.unreachable('fixture authority is required')
    type TestStore = BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    const executionStore: TestStore = {
      ...unusedAuthorityStore,
      completeHistory: () => unused,
      ingest: () => unused,
      ingestPositions: () => unused,
      account: () => unused,
      verifyCompleted: () => unused,
      value: () => unused,
      hasAccountBaseline: () => unused,
      retainCashReporting: () => Effect.void,
      bindings: () => unused,
      reconcile: () => unused,
      ensureAuthorityGeneration: () => Effect.succeed(authority),
      readAuthorityState: Effect.succeed(authority),
      restrictAuthority: () => unused,
    }
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: () => unused,
    }
    const brokerRead: BrokerReadShape = {
      account: unused,
      accountConfiguration: unused,
      assetBySymbol: unusedAssetBySymbol,
      positions: unused,
      orders: () => unused,
      orderById: () => unused,
      orderByClientId: () => unused,
      feeActivities: () => unused,
      fillActivities: () => unused,
      marketCalendar: () => unused,
    }
    const writerFence: WriterFenceService = {
      check: unused,
      transaction: (effect) => effect,
    }
    const capturedDriver = Effect.runSync(Deferred.make<RecoveryFirstCycleDriver>())
    const startup = makeObserveAutonomousCycleStartup(
      {
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 30_000,
        reconciliationIntervalMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        strategy: currentIntradayRuntime,
      },
      (driver) => Deferred.succeed(capturedDriver, driver).pipe(Effect.andThen(Effect.never)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acquireLoop: Effect.Effect<
            AutonomousCycleLoop<
              | BrokerRead
              | CycleStore
              | BrokerEventStore
              | FillAccountingStore
              | ValuationStore
              | ReconciliationStore
              | AuthorityGenerationStore
              | AuthorityRestrictionStore
              | IntentStore
              | MutationStore
              | WriterFence
              | CandidateObservationStore
              | JevTestServices
            >,
            OperationalError,
            AuthorityGenerationStore
          > = startup({
            cycleBindingId: 'c'.repeat(64),
            recordPass: () => Effect.die('driver publication must not execute a cycle pass'),
          })
          const loop = yield* acquireLoop.pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(CandidateObservationStore, {
              record: () => Effect.void,
              latestJevWindowEnd: () => Effect.succeed(Option.none()),
            }),
            provideJevTestServices,
            Effect.forkScoped,
          )
          const driver = yield* Deferred.await(capturedDriver).pipe(Effect.timeout('1 second'))
          expect(driver.nextDelayMs).toBe(30_000)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
  })

  test('bounds the complete writer-fenced reconciliation pass and interrupts stalled persistence', async () => {
    const signalSessionDate: IsoDate = '2020-04-29'
    const calendarMaterial = withProviderSessions({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
      source: 'alpaca-v2-calendar' as const,
      requestedRange: { start: signalSessionDate, end: '2020-05-29' },
      timeZone: 'UTC' as const,
      sessions: [
        {
          date: signalSessionDate,
          openAt: '2020-04-29T13:30:00.000Z',
          closeAt: '2020-04-29T20:00:00.000Z',
        },
        {
          date: signalDate,
          openAt: '2020-04-30T13:30:00.000Z',
          closeAt: '2020-04-30T20:00:00.000Z',
        },
      ],
    })
    const ordinaryCalendar: MarketCalendarObservation = {
      ...calendarMaterial,
      normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(calendarMaterial)),
    }
    const readEvidence = (identity: string): ReadEvidence => ({
      requestId: `bounded-pass-${identity}`,
      status: 200,
      contentHash: Result.getOrThrow(canonicalHashV1Result({ identity })),
      observedAt: reconciledAt,
    })
    const brokerAccount: BrokerAccount = {
      cryptoStatus: null,
      cashReportingQuantumMicros: '1' as const,
      nonMarginableBuyingPowerMicros: null,

      id: accountId,
      status: BrokerAccountStatus.Active,
      currency: 'USD',
      cashMicros: account.cashMicros,
      equityMicros: account.equityMicros,
      lastEquityMicros: account.equityMicros,
      buyingPowerMicros: account.buyingPowerMicros,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: reconciledAt,
    }
    const brokerRead: BrokerReadShape = {
      account: Effect.succeed({ value: brokerAccount, evidence: readEvidence('account') }),
      accountConfiguration: Effect.die(new Error('bounded reconciliation used account configuration')),
      assetBySymbol: unusedAssetBySymbol,
      positions: Effect.succeed({ value: [], evidence: readEvidence('positions') }),
      orders: () => Effect.succeed({ value: [], evidence: readEvidence('orders') }),
      orderById: () => Effect.die(new Error('bounded reconciliation used order lookup')),
      orderByClientId: () => Effect.die(new Error('bounded reconciliation used client-order lookup')),
      feeActivities: () => Effect.succeed({ value: { items: [] }, evidence: readEvidence('fees') }),
      fillActivities: () => Effect.succeed({ value: { items: [] }, evidence: readEvidence('fills') }),
      marketCalendar: (query) => {
        expect(query).toEqual(calendarMaterial.requestedRange)
        return Effect.succeed({ value: ordinaryCalendar, evidence: readEvidence('calendar') })
      },
    }
    const unusedCycleStore = Effect.die(new Error('bounded NOT_DUE pass attempted to mutate cycle state'))
    const cycleStore: CycleStoreShape = {
      acquire: () => unusedCycleStore,
      read: () => unusedCycleStore,
      readAuthoritySlot: () => Effect.succeed(Option.none()),
      readDecisionDocument: () => unusedCycleStore,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      activate: () => unusedCycleStore,
      bindDecision: () => unusedCycleStore,
      finish: () => unusedCycleStore,
      block: () => unusedCycleStore,
    }
    const exact = reconciliationResult()
    const authority = exact.riskContext.authority
    expect(authority).not.toBeNull()
    if (authority === null) expect.unreachable('bounded reconciliation fixture requires authority')
    const unusedAccounting = Effect.die(new Error('empty reconciliation must not account a fill'))
    let authorityRestrictions = 0
    let fencedTransactions = 0

    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(reconciledAt))
          const persistenceStarted = yield* Deferred.make<void>()
          const persistenceInterrupted = yield* Deferred.make<void>()
          const pass =
            yield* Deferred.make<
              Parameters<Parameters<ReturnType<typeof makeObserveAutonomousCycleStartup>>[0]['recordPass']>[0]
            >()
          const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.sync(() => {
              fencedTransactions += 1
            }).pipe(Effect.andThen(effect))
          const executionStore = {
            completeHistory: () => Effect.succeed(new Set()),
            ingest: () => Effect.succeed({ eventId: '1'.repeat(64), sourceSequence: '1', deduplicated: false }),
            ingestPositions: () => Effect.succeed({ snapshotId: '2'.repeat(64), eventIds: [], deduplicated: false }),
            account: () => unusedAccounting,
            verifyCompleted: () => Effect.void,
            value: () =>
              Effect.succeed({
                schemaVersion: 'bayn.paper-valuation.v1' as const,
                valuationId: '3'.repeat(64),
                accountId,
                sourceHash: '4'.repeat(64),
                cashMicros: account.cashMicros,
                longMarketValueMicros: '0',
                shortMarketValueMicros: '0',
                equityMicros: account.equityMicros,
                asOf: reconciledAt,
              }),
            hasAccountBaseline: () => Effect.succeed(true),
            retainCashReporting: () => Effect.void,
            bindings: () => Effect.succeed([]),
            reconcile: (_, snapshot) =>
              transaction(
                snapshot.pipe(
                  Effect.andThen(Deferred.succeed(persistenceStarted, undefined)),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(persistenceInterrupted, undefined).pipe(Effect.asVoid)),
                ),
              ),
            ensureAuthorityGeneration: () => Effect.succeed(authority),
            readAuthorityState: Effect.succeed(authority),
            readOrInitializeObserveAuthority: unusedAuthorityStore.readOrInitializeObserveAuthority,
            readResearchAuthorityGeneration: unusedAuthorityStore.readResearchAuthorityGeneration,
            readAuthorityGenerationLineage: unusedAuthorityStore.readAuthorityGenerationLineage,
            restrictAuthority: () =>
              Effect.sync(() => {
                authorityRestrictions += 1
              }),
          } satisfies BrokerEventStoreShape &
            FillAccountingStoreShape &
            ValuationStoreShape &
            ReconciliationStoreShape &
            AuthorityGenerationStoreShape &
            AuthorityRestrictionStoreShape
          const writerFence: WriterFenceService = {
            check: Effect.void,
            transaction,
          }
          const startup = makeObserveAutonomousCycleStartup({
            accountId,
            authorityGenerationHash: generationHash,
            pollIntervalMs: 1_000,
            reconciliationIntervalMs: 100,
            reconciliationPassTimeoutMs: 50,
            strategy: currentIntradayRuntime,
          })
          const loop = yield* startup({
            cycleBindingId: 'c'.repeat(64),
            recordPass: (result) => Deferred.succeed(pass, result).pipe(Effect.asVoid),
          }).pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(CandidateObservationStore, {
              record: () => Effect.void,
              latestJevWindowEnd: () => Effect.succeed(Option.none()),
            }),
            provideJevTestServices,
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(persistenceStarted)
          yield* TestClock.adjust(51)
          const result = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          yield* Deferred.await(persistenceInterrupted).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
          return result
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observation).toMatchObject({
      result: 'FAILURE',
      operation: 'reconcile',
      failure: 'market-data',
      message: 'same-pass broker reconciliation timed out after 50ms',
    })
    expect(fencedTransactions).toBe(1)
    expect(authorityRestrictions).toBe(0)
  })

  test('keeps the observe startup interface read-only by construction', () => {
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: currentIntradayRuntime,
    })

    expect(typeof startup).toBe('function')
  })

  test('binds mutation startup to the exact guarded execution program authority and strategy identity', async () => {
    for (const executionProgram of [
      sandboxExecutionProgram('9'.repeat(64)),
      sandboxExecutionProgram(generationHash, {
        ...currentIntradayRuntime.provenance.strategy,
        behaviorHash: '8'.repeat(64),
      }),
    ]) {
      const startup = makeMutationAutonomousCycleStartup({
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 30_000,
        reconciliationIntervalMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        strategy: currentIntradayRuntime,
        executionProgram,
      })

      const exit = await Effect.runPromise(
        Effect.exit(
          startup({
            cycleBindingId: 'c'.repeat(64),
            recordPass: () => Effect.void,
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error('mismatched mutation startup unexpectedly succeeded')
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isNone(failure)) throw new Error('mismatched mutation startup failed without a typed cause')

      expect(failure.value).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'cycle-loop',
        message: 'mutation cycle execution program does not match its account, authority generation, and strategy',
      })
    }
  })
})

test.each(['discovery', 'pending', 'not-ready', 'activation-expired', 'stalled'] as const)(
  'advances %s cycle admission in one bounded recovery pass',
  async (kind) => {
    const fixture = await executionLifecycleFixture()
    const services = makeExactReconciliationServices(Authority.Execution)
    let stored =
      kind === 'discovery'
        ? undefined
        : Effect.runSync(
            Schema.decodeUnknownEffect(
              AutonomousCycleSchema,
              strictParseOptions,
            )({ ...cycle, state: CycleState.Pending, stateVersion: 2 }),
          )
    let bound: CycleDecisionDocument | undefined
    let unfinishedReads = 0
    const operations: string[] = []
    const forbidden = () => Effect.die(new Error('admission must not perform a broker mutation'))
    const store: CycleStoreShape = {
      readOldestUnfinished: () =>
        Effect.sync(() => {
          unfinishedReads += 1
          return Option.fromUndefinedOr(stored)
        }),
      readAuthoritySlot: () => Effect.succeed(Option.none()),
      acquire: (acquired, at) =>
        Effect.sync(() => {
          operations.push('acquire')
          expect(acquired.identity.cycleId).toBe(cycle.identity.cycleId)
          stored = Effect.runSync(
            Schema.decodeUnknownEffect(
              AutonomousCycleSchema,
              strictParseOptions,
            )({
              ...acquired,
              state: CycleState.Pending,
              bindings: {},
              stateVersion: 1,
              createdAt: at,
              updatedAt: at,
            }),
          )
          return { cycle: stored, created: true }
        }),
      activate: (_id, at) =>
        Effect.gen(function* () {
          operations.push('activate')
          if (stored === undefined) throw new Error('activation requires its acquired cycle')
          stored = yield* Schema.decodeUnknownEffect(
            AutonomousCycleSchema,
            strictParseOptions,
          )({
            ...stored,
            state: kind === 'stalled' ? CycleState.Pending : CycleState.Active,
            stateVersion: stored.stateVersion + 1,
            updatedAt: at,
          }).pipe(Effect.orDie)
          if (kind === 'activation-expired') yield* TestClock.setTime(Date.parse(cycle.window.submissionCutoffAt))
          return { cycle: stored, changed: true }
        }),
      bindDecision: (_id, document, at) =>
        Effect.gen(function* () {
          operations.push('bind')
          if (stored === undefined) throw new Error('binding requires its active cycle')
          bound = document
          stored = yield* Schema.decodeUnknownEffect(
            AutonomousCycleSchema,
            strictParseOptions,
          )({
            ...stored,
            bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
            stateVersion: stored.stateVersion + 1,
            updatedAt: at,
          }).pipe(Effect.orDie)
          return { cycle: stored, changed: true }
        }),
      readDecisionDocument: () =>
        Effect.sync(() => {
          operations.push('read-bound')
          return Option.fromUndefinedOr(bound)
        }),
      block: (_id, reason, at) =>
        Effect.gen(function* () {
          operations.push('block')
          if (stored === undefined) throw new Error('blocking requires its current cycle')
          stored = yield* Schema.decodeUnknownEffect(
            AutonomousCycleSchema,
            strictParseOptions,
          )({
            ...stored,
            state: CycleState.Blocked,
            terminalReason: reason,
            stateVersion: stored.stateVersion + 1,
            updatedAt: at,
            terminalAt: at,
          }).pipe(Effect.orDie)
          return { cycle: stored, changed: true }
        }),
      read: forbidden,
      finish: forbidden,
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt) + (kind === 'discovery' ? 60_000 : 0))
        return yield* Effect.exit(
          runRecoveryFirstCyclePass(
            fixture.input,
            fixture.policy,
            {
              cycleBindingId: cycle.identity.qualificationRunId,
              accountId,
              strategyName: 'jev',
              strategyProtocolHash: fixture.preparation.strategyProtocolHash,
              executionPolicy: fixture.preparation.executionPolicy,
              buildDecision: () =>
                Effect.suspend(() => {
                  operations.push('build')
                  return kind === 'not-ready'
                    ? Effect.fail(
                        new CycleDecisionBuildError({
                          failure: 'not-ready',
                          message: 'incomplete market window',
                          readiness: {
                            reason: DecisionReadinessReason.SnapshotCoverage,
                            message: 'incomplete market window',
                          },
                        }),
                      )
                    : Effect.succeed(fixture.document)
                }),
              buildDecisionEvidence: () =>
                Effect.sync(() => {
                  operations.push('verify')
                  return {}
                }),
            },
            {
              read: Effect.succeed(reconciliationResultAt(evaluatedAt)),
              refresh: Effect.succeed(reconciliationResultAt(evaluatedAt)),
            },
            { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
          ),
        )
      }).pipe(
        Effect.provideService(CycleStore, store),
        Effect.provideService(BrokerRead, {
          ...services.brokerRead,
          marketCalendar: calendarRead([...calendar.sessions]),
        }),
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
          commit: forbidden,
          read: (id) =>
            Effect.succeed(
              Option.fromUndefinedOr(fixture.intents.find((intent) => intent.intentId === id)).pipe(
                Option.map((intent) => {
                  const decision = fixture.document.deltaRisk[fixture.intents.indexOf(intent)]?.evaluation.decision
                  if (decision === undefined) throw new Error('fixture intent lacks its risk decision')
                  const record = storedIntent(intent, IntentState.Terminal, evaluatedAt, TerminalOutcome.Filled)
                  return { ...record, intent: { ...record.intent, riskDecisionId: decision.decisionId }, decision }
                }),
              ),
            ),
        }),
        Effect.provideService(MutationStore, {
          latest: () => Effect.void,
        } as unknown as MutationStoreShape),
        Effect.provideService(AuthorityGenerationStore, services.executionStore),
        Effect.provideService(BrokerEventStore, services.executionStore),
        Effect.provideService(FillAccountingStore, services.executionStore),
        Effect.provideService(ValuationStore, services.executionStore),
        Effect.provideService(ReconciliationStore, services.executionStore),
        Effect.provideService(AuthorityRestrictionStore, services.executionStore),
        Effect.provideService(WriterFence, services.writerFence),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(unfinishedReads).toBe(1)
    if (kind === 'stalled') {
      expect(Exit.isFailure(result)).toBe(true)
      expect(operations).toEqual(['activate', 'activate'])
    } else {
      if (Exit.isFailure(result)) throw new Error(Cause.pretty(result.cause))
      expect(result.value).toMatchObject({
        outcome: 'RECOVERED',
        action: kind === 'activation-expired' ? 'BLOCKED' : 'WAITING',
      })
      expect(operations).toEqual(
        kind === 'not-ready'
          ? ['activate', 'build']
          : kind === 'activation-expired'
            ? ['activate', 'block']
            : [...(kind === 'discovery' ? ['acquire'] : []), 'activate', 'build', 'verify', 'bind', 'read-bound'],
      )
    }
  },
)

test.each(['verified', 'empty', 'contract', 'not-ready'] as const)(
  'decision evidence %s result is required before durable binding',
  async (kind) => {
    const fixture = await executionLifecycleFixture()
    const services = makeExactReconciliationServices(Authority.Execution)
    const operations: string[] = []
    const evidence = kind === 'empty' ? {} : { streamingSnapshotReferences: [] }
    const failure = new CycleDecisionBuildError({
      failure: kind === 'not-ready' ? 'not-ready' : 'contract',
      message: 'canonical market evidence unavailable',
    })
    const forbidden = () => Effect.die(new Error('unexpected decision-binding operation'))
    const store: CycleStoreShape = {
      acquire: forbidden,
      read: forbidden,
      readAuthoritySlot: forbidden,
      readOldestUnfinished: forbidden,
      readDecisionDocument: forbidden,
      activate: forbidden,
      finish: forbidden,
      block: forbidden,
      bindDecision: (_id, document, _at, verified) =>
        Effect.sync(() => {
          operations.push('bind')
          expect(document).toBe(fixture.document)
          expect(verified).toBe(evidence)
          return { cycle, changed: true }
        }),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* Effect.exit(
          runAutonomousCyclePass(
            {
              cycleBindingId: cycle.identity.qualificationRunId,
              accountId,
              strategyName: 'jev',
              strategyProtocolHash: fixture.preparation.strategyProtocolHash,
              executionPolicy: fixture.preparation.executionPolicy,
              buildDecision: () =>
                Effect.sync(() => {
                  operations.push('build')
                  return fixture.document
                }),
              buildDecisionEvidence: (document) =>
                Effect.suspend(() => {
                  operations.push('verify')
                  expect(document).toBe(fixture.document)
                  return kind === 'contract' || kind === 'not-ready' ? Effect.fail(failure) : Effect.succeed(evidence)
                }),
            },
            cycle,
          ),
        )
      }).pipe(
        Effect.provideService(BrokerRead, services.brokerRead),
        Effect.provideService(CycleStore, store),
        Effect.provide(TestClock.layer()),
      ),
    )
    if (kind === 'contract' || kind === 'not-ready') {
      expect(operations).toEqual(['build', 'verify'])
      if (Exit.isSuccess(result)) throw new Error('failed evidence must not bind a decision')
      expect(Cause.findErrorOption(result.cause)).toEqual(
        Option.some(
          new CycleRunnerError({
            operation: 'build-decision',
            failure: 'contract',
            message: failure.message,
            cause: failure,
          }),
        ),
      )
    } else {
      expect(operations).toEqual(['build', 'verify', 'bind'])
      if (Exit.isFailure(result)) throw new Error(Cause.pretty(result.cause))
      expect(result.value).toMatchObject({ outcome: 'RECOVERED', action: 'BOUND_DECISION' })
    }
  },
)

test('reads the execution closure once without weakening completion evidence', async () => {
  const fixture = await executionLifecycleFixture()
  const services = makeExactReconciliationServices(Authority.Execution)
  const at = utcInstantFromEpochMillis(Date.parse(cycle.window.executionCloseAt) - 239_000)
  let closureReads = 0
  const forbidden = () => Effect.die(new Error('flat close must not create a plan or broker mutation'))
  const store: CycleStoreShape = {
    acquire: forbidden,
    read: forbidden,
    readAuthoritySlot: forbidden,
    readOldestUnfinished: () => Effect.succeed(Option.some(fixture.boundCycle)),
    readDecisionDocument: () => Effect.succeed(Option.some(fixture.document)),
    activate: forbidden,
    bindDecision: forbidden,
    finish: forbidden,
    block: forbidden,
  }
  const records = fixture.intents.map((intent, index) => {
    const decision = fixture.document.deltaRisk[index]?.evaluation.decision
    if (decision === undefined) throw new Error('fixture intent lacks its risk decision')
    const record = storedIntent(intent, IntentState.Terminal, evaluatedAt, TerminalOutcome.Filled)
    return { ...record, intent: { ...record.intent, riskDecisionId: decision.decisionId }, decision }
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at))
      return yield* Effect.exit(
        runRecoveryFirstCyclePass(
          {
            ...fixture.input,
            executionCycleClosureStore: {
              read: () =>
                Effect.sync(() => {
                  closureReads += 1
                  return Option.none()
                }),
              readLatestReplan: forbidden,
              bind: forbidden,
              bindReplan: forbidden,
              containsIntent: forbidden,
            },
          },
          fixture.policy,
          {
            cycleBindingId: cycle.identity.qualificationRunId,
            accountId,
            strategyName: 'jev',
            strategyProtocolHash: fixture.preparation.strategyProtocolHash,
            executionPolicy: fixture.preparation.executionPolicy,
            buildDecision: forbidden,
            buildDecisionEvidence: forbidden,
          },
          { read: Effect.succeed(reconciliationResultAt(at)), refresh: Effect.succeed(reconciliationResultAt(at)) },
          { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
        ),
      )
    }).pipe(
      Effect.provideService(CycleStore, store),
      Effect.provideService(BrokerRead, services.brokerRead),
      Effect.provideService(IntentStore, {
        protectionForCycle: () => Effect.succeed([]),
        beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
        commit: forbidden,
        read: (id) => Effect.succeed(Option.fromUndefinedOr(records.find((record) => record.intent.intentId === id))),
      }),
      Effect.provideService(MutationStore, {
        latest: () => Effect.void,
      } as unknown as MutationStoreShape),
      Effect.provideService(AuthorityGenerationStore, services.executionStore),
      Effect.provideService(BrokerEventStore, services.executionStore),
      Effect.provideService(FillAccountingStore, services.executionStore),
      Effect.provideService(ValuationStore, services.executionStore),
      Effect.provideService(ReconciliationStore, services.executionStore),
      Effect.provideService(AuthorityRestrictionStore, services.executionStore),
      Effect.provideService(WriterFence, services.writerFence),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(closureReads).toBe(1)
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isSuccess(result)) throw new Error('missing completion evidence must fail closed')
  expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
    _tag: 'CycleRunnerError',
    message: 'cycle completion requires its exact durable decision evidence',
  })
})

test('settles the committed close after native protection observes a flat account', async () => {
  const fixture = await executionLifecycleFixture()
  const services = makeExactReconciliationServices(Authority.Execution)
  const at = utcInstantFromEpochMillis(Date.parse(fixture.boundCycle.window.executionCloseAt) - 239_000)
  const position: Position = {
    schemaVersion: 'bayn.position.v2',
    costBasisMicros: '100000000',
    accountId,
    symbol: fixture.intent.symbol,
    quantityAtoms: '1000000000',
    averageEntryPriceMicros: '100000000',
    marketPriceMicros: '100000000',
    marketValueMicros: '100000000',
    unrealizedPnlMicros: '0',
    observedAt: at,
  }
  const forbidden = () => Effect.die('settling a filled close cannot submit, cancel or create another plan')
  const records = new Map(
    fixture.intents.map((intent, index) => {
      const decision = fixture.document.deltaRisk[index]?.evaluation.decision
      if (decision === undefined) throw new Error('missing entry risk decision')
      return [
        intent.intentId,
        {
          ...storedIntent(
            { ...intent, riskDecisionId: decision.decisionId },
            IntentState.Terminal,
            at,
            TerminalOutcome.Filled,
          ),
          decision,
        },
      ] as const
    }),
  )
  let completionEvidence = false
  let finished = 0
  const recovered: string[] = []
  const store: CycleStoreShape = {
    acquire: forbidden,
    read: forbidden,
    readAuthoritySlot: forbidden,
    readOldestUnfinished: () => Effect.succeed(Option.some(fixture.boundCycle)),
    readDecisionDocument: () =>
      Effect.succeed(
        Option.some(
          attachCycleDecisionStoreEvidence(fixture.document, {
            executionCompletionEvidenceMatches: completionEvidence,
            executionGenerationIsSuperseded: false,
          }),
        ),
      ),
    activate: forbidden,
    bindDecision: forbidden,
    block: forbidden,
    finish: (_id, state, observedAt) =>
      Effect.sync(() => {
        finished += 1
        return { cycle: { ...fixture.boundCycle, state, updatedAt: observedAt, terminalAt: observedAt }, changed: true }
      }),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at))
      const close = (yield* prepareClosingExecutionCycleDecision({
        input: fixture.input,
        preparation: fixture.preparation,
        policy: fixture.policy,
        cycle: fixture.boundCycle,
        entryDocument: fixture.document,
        reconcile: Effect.succeed(reconciliationResultAt(at, 0, 0, [position])),
        closeExpiresAt: fixture.boundCycle.window.executionCloseAt,
      })).document
      const target = close.targetPlan.intentTargets[0]
      const risk = close.deltaRisk[0]
      if (target === undefined || risk === undefined) throw new Error('missing close intent')
      const intent = yield* planExecutionIntent(
        {
          schemaVersion: 'bayn.intent-plan.v3',
          ...target,
          notionalLimitMicros: risk.notionalLimitMicros,
          limitPriceMicros: risk.limitPriceMicros,
          createdAt: close.createdAt,
        },
        {
          authority: {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash,
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
            version: 1,
            updatedAt: at,
          },
        },
      )
      records.set(intent.intentId, {
        ...storedIntent(
          { ...intent, riskDecisionId: risk.evaluation.decision.decisionId },
          IntentState.Acknowledged,
          at,
        ),
        decision: risk.evaluation.decision,
      })
      const closure = yield* Effect.fromResult(
        makeExecutionCycleClosure({
          schemaVersion: 'bayn.paper-cycle-closure.v1',
          cycleId: fixture.boundCycle.identity.cycleId,
          entryDecisionHash: fixture.document.contentHash,
          document: close,
          createdAt: close.createdAt,
          expiresAt: close.expiresAt,
        }),
      )
      const accepted: MutationEvent = {
        schemaVersion: 'bayn.paper-mutation-event.v1',
        eventId: '6'.repeat(64),
        mutationId: '7'.repeat(64),
        requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(intent)))),
        intentId: intent.intentId,
        sequence: 2,
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitAccepted,
        consistencyDelayMs: 1_000,
        brokerOrderId: 'filled-close',
        occurredAt: at,
      }
      const order: Order = {
        schemaVersion: 'bayn.order.v3',
        accountId,
        brokerOrderId: 'filled-close',
        clientOrderId: intent.clientOrderId,
        intentId: intent.intentId,
        symbol: intent.symbol,
        side: intent.side,
        orderType: intent.orderType,
        timeInForce: intent.timeInForce,
        quantityAtoms: intent.quantityAtoms,
        filledQuantityAtoms: intent.quantityAtoms,
        limitPriceMicros: intent.limitPriceMicros,
        status: OrderStatus.Filled,
        observedAt: at,
      }
      const program: ExecutionProgram = {
        ...sandboxExecutionProgram(),
        recover: (id, operation) =>
          Effect.sync(() => {
            expect(operation).toBe(MutationOperation.Submit)
            recovered.push(id)
            records.set(id, {
              ...storedIntent(
                { ...intent, riskDecisionId: risk.evaluation.decision.decisionId },
                IntentState.Terminal,
                at,
                TerminalOutcome.Filled,
              ),
              decision: risk.evaluation.decision,
            })
            return { ...accepted, eventId: '9'.repeat(64), sequence: 3, eventType: MutationEventType.RecoveryFound }
          }),
      }
      const facts = reconciliationResultAt(at, 0, 0, [], [order])
      const advance = runRecoveryFirstCyclePass(
        {
          ...fixture.input,
          executionCycleClosureStore: {
            read: () => Effect.succeed(Option.some(closure)),
            readLatestReplan: () => Effect.succeed(Option.none()),
            bind: forbidden,
            bindReplan: forbidden,
            containsIntent: forbidden,
          },
        },
        fixture.policy,
        {
          cycleBindingId: fixture.boundCycle.identity.qualificationRunId,
          accountId,
          strategyName: 'jev',
          strategyProtocolHash: fixture.preparation.strategyProtocolHash,
          executionPolicy: fixture.preparation.executionPolicy,
          buildDecision: forbidden,
          buildDecisionEvidence: forbidden,
        },
        { read: Effect.succeed(facts), refresh: Effect.succeed(facts) },
        { _tag: 'Mutation', executionProgram: program },
      ).pipe(
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: forbidden,
          commit: forbidden,
          commitClosing: forbidden,
          read: (id) => Effect.succeed(Option.fromUndefinedOr(records.get(id))),
        }),
        Effect.provideService(MutationStore, {
          latest: (id, operation) =>
            Effect.succeed(id === intent.intentId && operation === MutationOperation.Submit ? accepted : undefined),
          authorizeSubmit: forbidden,
          beginSubmit: forbidden,
          submitAccepted: forbidden,
          submitRejected: forbidden,
          submitDenied: forbidden,
          submitUnknown: forbidden,
          beginCancel: forbidden,
          cancelAccepted: forbidden,
          cancelUnknown: forbidden,
          recoveryFound: forbidden,
          recoveryNotFound: forbidden,
          recoveryUnknown: forbidden,
        }),
      )
      yield* TestClock.adjust(2_000)
      expect(yield* advance).toMatchObject({ _tag: 'PostMutationReconciliation' })
      expect(recovered).toEqual([intent.intentId])
      expect(finished).toBe(0)
      expect(yield* advance).toMatchObject({ action: 'WAITING', waitReason: 'COMPLETION_EVIDENCE_PENDING' })
      expect(finished).toBe(0)
      completionEvidence = true
      expect(yield* advance).toMatchObject({ action: 'COMPLETED', cycle: { state: CycleState.Completed } })
      expect(finished).toBe(1)
      expect(recovered).toEqual([intent.intentId])
    }).pipe(
      Effect.provideService(CycleStore, store),
      Effect.provideService(BrokerEventStore, services.executionStore),
      Effect.provideService(FillAccountingStore, services.executionStore),
      Effect.provideService(ValuationStore, services.executionStore),
      Effect.provideService(ReconciliationStore, services.executionStore),
      Effect.provideService(AuthorityGenerationStore, services.executionStore),
      Effect.provideService(AuthorityRestrictionStore, services.executionStore),
      Effect.provideService(WriterFence, services.writerFence),
      (effect) => provideDecisionServices(effect, calendarRead([])),
      Effect.provide(TestClock.layer()),
    ),
  )
})

test('persists the pricing quote event and its full freshness deadline for every entry target', async () => {
  const fixture = await executionLifecycleFixture()
  expect(fixture.document.entryLimitSlippageBps).toBe(10)
  expect(Result.isSuccess(decodeExecutionDecisionDocument(fixture.document))).toBeTrue()
  expect(fixture.document.deltaRisk.length).toBeGreaterThan(0)
  for (const risk of fixture.document.deltaRisk) {
    expect(risk.facts?.state.entryQuote).toEqual({ eventAt: '2020-05-01T16:45:01.000Z', maximumAgeMs: 10_000 })
    expect(risk.evaluation.decision.expiresAt).toBe('2020-05-01T16:45:11.000Z')
    expect(risk.evaluation.input.freshUntil).toBe(risk.evaluation.decision.expiresAt)
    const facts = risk.facts
    if (facts === undefined) throw new Error('entry is missing durable risk facts')
    const reference = BigInt(facts.state.referencePriceMicros)
    const limit = BigInt(facts.state.expectedExecutionPriceMicros)
    expect(limit).toBeGreaterThan(reference)
    expect((limit - reference) * 10_000n).toBeLessThanOrEqual(reference * 10n)
  }
  const { contentHash: _contentHash, ...material } = fixture.document
  expect(Result.isFailure(makeExecutionDecisionDocument({ ...material, entryLimitSlippageBps: 11 }))).toBeTrue()
  expect(Result.isFailure(makeExecutionDecisionDocument({ ...material, closeLimitSlippageBps: 10 }))).toBeTrue()
  const { entryLimitSlippageBps: _allowance, ...withoutAllowance } = material
  expect(Result.isFailure(makeExecutionDecisionDocument(withoutAllowance))).toBeTrue()
})

test('decision construction crossing the admission lease cannot bind its completed decision', async () => {
  const fixture = await executionLifecycleFixture()
  expect(Result.getOrThrow(decideDecisionBinding(cycle, fixture.document, fixture.document.createdAt, []))._tag).toBe(
    'Persist',
  )
  const late = Result.getOrThrow(
    decideDecisionBinding(cycle, fixture.document, utcInstantFromEpochMillis(unusedEntryExpiresAt(cycle)), []),
  )
  expect(late._tag).toBe('Block')
  if (late._tag !== 'Block') throw new Error('Expected expired admission')
  expect(late.reason).toBe(CycleTerminalReason.UnusedEntryExpired)
})

test('recovery preserves a fresh admission for a real next strategy decision', async () => {
  const fixture = await executionLifecycleFixture()
  let stored = cycle
  let bound: CycleDecisionDocument | undefined
  let snapshotLoads = 0
  let projectionReady = false
  const snapshots: Parameters<typeof fixtureStreamingReference>[0][] = []
  const unavailable = (name: string) => Effect.die(new Error(`unexpected recovery operation: ${name}`))
  const store: CycleStoreShape = {
    acquire: () => unavailable('acquire'),
    read: () => Effect.succeed(Option.some(stored)),
    readAuthoritySlot: () => Effect.succeed(Option.some(stored)),
    readOldestUnfinished: () =>
      Effect.sync(() => (stored.state === CycleState.Active ? Option.some(stored) : Option.none())),
    readDecisionDocument: () => Effect.sync(() => Option.fromUndefinedOr(bound)),
    activate: () => unavailable('activate'),
    bindDecision: (cycleId, document, observedAt, evidence) =>
      Effect.sync(() => {
        expect(cycleId).toBe(cycle.identity.cycleId)
        expect(document.targetPlan.status).toBe(TargetPlanStatus.Planned)
        expect(evidence?.streamingSnapshotReferences?.length).toBeGreaterThan(0)
        bound = document
        stored = Effect.runSync(
          Schema.decodeUnknownEffect(
            AutonomousCycleSchema,
            strictParseOptions,
          )({
            ...stored,
            bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
            stateVersion: stored.stateVersion + 1,
            updatedAt: observedAt,
          }),
        )
        return { cycle: stored, changed: true }
      }),
    finish: (_cycleId, state, observedAt) =>
      Effect.sync(() => {
        stored = Effect.runSync(
          Schema.decodeUnknownEffect(
            AutonomousCycleSchema,
            strictParseOptions,
          )({
            ...stored,
            state,
            stateVersion: stored.stateVersion + 1,
            updatedAt: observedAt,
            terminalAt: observedAt,
          }),
        )
        return { cycle: stored, changed: true }
      }),
    block: () => unavailable('block'),
  }
  const intradayMarketData: IntradayMarketDataService = {
    check: Effect.suspend(() =>
      projectionReady
        ? Effect.void
        : Effect.fail(
            operationalError({
              component: 'market-data',
              operation: 'check',
              message: 'projection disconnected',
            }),
          ),
    ),
    loadSnapshot: (query) =>
      Effect.suspend(() => {
        if (!projectionReady) return Effect.fail(marketDataOperationError('load', 'projection disconnected', undefined))
        return Effect.sync(() => {
          snapshotLoads += 1
          const snapshot = streamingFixtureFromRaw(
            makeIntradayMomentumTestSnapshot(
              currentIntradayProtocol,
              { ...query, archiveWatermarks: [] },
              { NVDA: 0.02 },
              10,
            ),
            query,
          ).snapshot
          snapshots.push(snapshot)
          return snapshot
        })
      }),
    verifyReference: fixtureStreamingReference,
  }
  const services = makeExactReconciliationServices(Authority.Execution)
  const executionStore = services.executionStore
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const beforeOpenAt = utcInstantFromEpochMillis(Date.parse(cycle.window.submissionOpenAt) - 1_000)
      stored = yield* Schema.decodeUnknownEffect(
        AutonomousCycleSchema,
        strictParseOptions,
      )({ ...cycle, createdAt: beforeOpenAt, updatedAt: beforeOpenAt })
      yield* TestClock.setTime(Date.parse(beforeOpenAt))
      const beforeOpen = yield* runAutonomousCyclePass(
        {
          cycleBindingId: cycle.identity.qualificationRunId,
          accountId,
          strategyName: 'jev',
          strategyProtocolHash: fixture.preparation.strategyProtocolHash,
          executionPolicy: fixture.preparation.executionPolicy,
          buildDecision: () => unavailable('build decision before submission opens'),
          buildDecisionEvidence: () => unavailable('verify decision before submission opens'),
        },
        stored,
      )
      expect(beforeOpen).toMatchObject({
        outcome: 'RECOVERED',
        action: 'WAITING',
        waitReason: 'AWAITING_SUBMISSION_OPEN',
        observedAt: beforeOpenAt,
      })
      stored = cycle
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const input = { ...fixture.input, intradayMarketData }
      const startup = { cycleBindingId: cycle.identity.qualificationRunId, recordPass: () => Effect.void }
      const restricted = yield* yield* makeMutationAutonomousCycleStartupProduction(input, 'RecoveryOnly')(startup)
      const held = yield* restricted.advance
      expect(held.result).toMatchObject({ outcome: 'WINDOW_CLOSED' })
      expect(stored.state).toBe(CycleState.Active)
      expect(snapshotLoads).toBe(0)
      const active = yield* yield* makeMutationAutonomousCycleStartupProduction(input, 'Mutation')(startup)
      const unhealthy = yield* active.advance
      expect(unhealthy.observation).toMatchObject({ result: 'FAILURE', failure: 'market-data' })
      expect(snapshotLoads).toBe(0)
      projectionReady = true
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const evaluated = yield* runAutonomousCyclePass<ObserveDecisionRuntime>(
        {
          cycleBindingId: cycle.identity.qualificationRunId,
          accountId,
          strategyName: 'jev',
          strategyProtocolHash: fixture.preparation.strategyProtocolHash,
          executionPolicy: fixture.preparation.executionPolicy,
          buildDecision: (subject) =>
            mutationDecisionBuilder(
              input,
              fixture.preparation,
              fixture.policy,
            )(subject, Effect.succeed(reconciliationResultAt(evaluatedAt))),
          buildDecisionEvidence: () =>
            Effect.forEach(snapshots, fixtureStreamingReference).pipe(
              Effect.map((references) => ({
                streamingSnapshotReferences: references.filter(
                  (reference) => reference.schemaVersion === 'bayn.streaming-snapshot-reference.v1',
                ),
              })),
              Effect.mapError(
                (cause) =>
                  new CycleDecisionBuildError({
                    failure: 'market-data',
                    message: 'Fixture reference verification failed',
                    cause,
                  }),
              ),
            ),
        },
        stored,
      )
      expect(evaluated).toMatchObject({ outcome: 'RECOVERED', action: 'BOUND_DECISION' })
      return { evaluated, document: bound, cycle: stored }
    }).pipe(
      Effect.provideService(BrokerRead, { ...services.brokerRead, marketCalendar: calendarRead([]) }),
      Effect.provideService(CycleStore, store),
      Effect.provideService(BrokerEventStore, executionStore),
      Effect.provideService(FillAccountingStore, executionStore),
      Effect.provideService(ValuationStore, executionStore),
      Effect.provideService(ReconciliationStore, executionStore),
      Effect.provideService(AuthorityGenerationStore, executionStore),
      Effect.provideService(AuthorityRestrictionStore, executionStore),
      Effect.provideService(IntentStore, {} as IntentStoreService),
      Effect.provideService(MutationStore, {} as MutationStoreShape),
      Effect.provideService(WriterFence, services.writerFence),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(snapshotLoads).toBeGreaterThan(0)
  expect(result.document?.targetPlan.status).toBe(TargetPlanStatus.Planned)
  expect(result.cycle.bindings.decisionHash).toBe(result.document?.contentHash)
})

test('reconciliation cancels a slow broker read before the aggregate pass deadline', async () => {
  const services = makeExactReconciliationServices(Authority.Execution)
  const store = services.executionStore
  let cancelled = false
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const account = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            cancelled = true
          }),
        ),
      )
      const attempt = yield* Effect.flip(boundedReconciliationPass(3_000)).pipe(
        Effect.provideService(BrokerRead, { ...services.brokerRead, account }),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust(999)
      expect(attempt.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      return yield* Fiber.join(attempt)
    }).pipe(
      Effect.provideService(BrokerEventStore, store),
      Effect.provideService(FillAccountingStore, store),
      Effect.provideService(ValuationStore, store),
      Effect.provideService(ReconciliationStore, store),
      Effect.provideService(AuthorityGenerationStore, store),
      Effect.provideService(AuthorityRestrictionStore, store),
      Effect.provideService(WriterFence, services.writerFence),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(cancelled).toBe(true)
  expect(error).toMatchObject({
    _tag: 'BrokerReadError',
    kind: BrokerReadErrorKind.Timeout,
    operation: 'account',
    retryable: true,
  })
})

test.each(['preflight', 'cycle'] as const)(
  'a generation deadline during %s retains its safety classification and cancels the stalled work',
  async (phase) => {
    const fixture = await executionLifecycleFixture()
    const services = makeExactReconciliationServices(Authority.Execution)
    let restrictions = 0
    let reconciliations = 0
    let cycleReads = 0
    let interrupted = 0
    const forbidden = () => Effect.die('deadline must not reach a decision or broker mutation')
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(reconciledAt))
        const entered = yield* Deferred.make<void>()
        const stall = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted += 1
            }),
          ),
        )
        const executionStore = {
          ...services.executionStore,
          reconcile: (accountId, snapshot) =>
            Effect.suspend(() => {
              reconciliations += 1
              return phase === 'preflight' && reconciliations === 1
                ? stall
                : services.executionStore.reconcile(accountId, snapshot)
            }),
          restrictAuthority: () =>
            Effect.sync(() => {
              restrictions += 1
            }),
        } satisfies ReconciliationStoreShape & AuthorityRestrictionStoreShape
        const cycleStore: CycleStoreShape = {
          readOldestUnfinished: () =>
            Effect.suspend(() => {
              cycleReads += 1
              return phase === 'cycle'
                ? stall
                : Effect.fail(
                    new CycleStoreError({
                      operation: 'read-oldest-unfinished',
                      failure: 'query',
                      persistenceFailure: 'connectivity',
                      message: 'retry reached a fresh cycle read',
                    }),
                  )
            }),
          acquire: forbidden,
          read: forbidden,
          readAuthoritySlot: forbidden,
          readDecisionDocument: forbidden,
          activate: forbidden,
          bindDecision: forbidden,
          finish: forbidden,
          block: forbidden,
        }
        return yield* Effect.gen(function* () {
          const driver = yield* Effect.fromResult(
            makeRecoveryFirstCycleDriver(
              { ...fixture.input, reconciliationPassTimeoutMs: 100, reconciliationIntervalMs: 100 },
              { cycleBindingId: cycle.identity.qualificationRunId, recordPass: () => Effect.void },
              fixture.preparation,
              fixture.policy,
              { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
              forbidden,
              'mutation autonomous cycle loop',
            ),
          ).pipe(Effect.flatten)
          const permit = yield* Semaphore.make(1)
          const first = yield* runRestateAdvanceWithinTimeout(
            permit,
            driver.advance,
            99,
            driver.onTimeout,
            'bayn.execution.generation-pass',
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(entered)
          yield* TestClock.adjust(100)
          const advanced = yield* Fiber.join(first)
          expect(advanced.observation).toMatchObject({
            result: 'FAILURE',
            operation: phase === 'preflight' ? 'reconcile' : 'run-cycle-pass',
          })
          expect(interrupted).toBe(1)
          expect(restrictions).toBe(phase === 'preflight' ? 0 : 1)
          if (phase === 'preflight') {
            const retry = yield* driver.advance
            expect(retry.observation).toMatchObject({ result: 'FAILURE', operation: 'read-oldest-unfinished' })
            expect(reconciliations).toBe(2)
            expect(cycleReads).toBe(1)
            expect(restrictions).toBe(0)
          }
        }).pipe(
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(BrokerEventStore, executionStore),
          Effect.provideService(FillAccountingStore, executionStore),
          Effect.provideService(ValuationStore, executionStore),
          Effect.provideService(ReconciliationStore, executionStore),
          Effect.provideService(AuthorityGenerationStore, executionStore),
          Effect.provideService(AuthorityRestrictionStore, executionStore),
          Effect.provideService(WriterFence, services.writerFence),
          Effect.provideService(IntentStore, {
            protectionForCycle: () => Effect.succeed([]),
            beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
            commit: forbidden,
            read: forbidden,
          }),
          Effect.provideService(MutationStore, {
            authorizeSubmit: forbidden,
            beginSubmit: forbidden,
            submitAccepted: forbidden,
            submitRejected: forbidden,
            submitDenied: forbidden,
            submitUnknown: forbidden,
            beginCancel: forbidden,
            cancelAccepted: forbidden,
            cancelUnknown: forbidden,
            recoveryFound: forbidden,
            recoveryNotFound: forbidden,
            recoveryUnknown: forbidden,
            latest: forbidden,
          }),
          Effect.provideService(CandidateObservationStore, { record: forbidden, latestJevWindowEnd: forbidden }),
          provideJevTestServices,
        )
      }).pipe(Effect.provideService(BrokerRead, services.brokerRead), Effect.provide(TestClock.layer())),
    )
  },
)

test.each([
  { phase: 'CLOSE' as const, marked: true, kind: BrokerReadErrorKind.Timeout, closeMs: 60_000, fast: true },
  { phase: 'CLOSE' as const, marked: true, kind: BrokerReadErrorKind.Timeout, closeMs: 2_500, fast: true },
  {
    phase: 'CLOSE' as const,
    marked: true,
    kind: BrokerReadErrorKind.Timeout,
    closeMs: 60_000,
    fast: true,
    clearOnError: true,
  },
  { phase: 'ENTRY' as const, marked: true, kind: BrokerReadErrorKind.Timeout, closeMs: 60_000, fast: false },
  { phase: 'CLOSE' as const, marked: false, kind: BrokerReadErrorKind.Timeout, closeMs: 60_000, fast: false },
  { phase: 'CLOSE' as const, marked: true, kind: BrokerReadErrorKind.Authentication, closeMs: 60_000, fast: false },
  { phase: 'CLOSE' as const, marked: true, kind: BrokerReadErrorKind.Timeout, closeMs: 0, fast: false },
])('post-exit missing-cut retry preserves failure and guards: $phase/$marked/$kind/$closeMs', async (scenario) => {
  const fixture = await executionLifecycleFixture()
  const services = makeExactReconciliationServices(Authority.Execution)
  const forbidden = () => Effect.die(new Error('missing broker evidence cannot mutate or acquire a cycle'))
  const exitCycle = {
    ...cycle,
    window: { ...cycle.window, executionCloseAt: new Date(Date.parse(evaluatedAt) + scenario.closeMs).toISOString() },
  }
  let unavailable = false
  let errorKind = scenario.kind
  let errorMarked = scenario.marked
  let reads = 0
  let cyclePasses = 0
  const pass = spyOn(executionCycleModule, 'runRecoveryFirstCyclePass').mockImplementation(() =>
    Effect.sync(() => {
      cyclePasses += 1
      return cyclePasses === 1
        ? {
            _tag: 'PostMutationReconciliation' as const,
            cycle: exitCycle,
            delayMs: 1_000,
            observedAt: evaluatedAt,
            logContext: {
              cycleId: cycle.identity.cycleId,
              intentId: 'a'.repeat(64),
              mutationAction: 'CANCEL' as const,
              mutationPhase: scenario.phase,
            },
          }
        : {
            outcome: 'RECOVERED' as const,
            action: 'WAITING' as const,
            waitReason: 'JEV_POSITION_HELD' as const,
            observedAt: evaluatedAt,
            cycle: exitCycle,
          }
    }),
  )
  const cycleStore: CycleStoreShape = {
    readOldestUnfinished: forbidden,
    acquire: forbidden,
    read: forbidden,
    readAuthoritySlot: forbidden,
    readDecisionDocument: forbidden,
    activate: forbidden,
    bindDecision: forbidden,
    finish: forbidden,
    block: forbidden,
  }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        const makeDriver = Effect.fromResult(
          makeRecoveryFirstCycleDriver(
            fixture.input,
            { cycleBindingId: cycle.identity.qualificationRunId, recordPass: () => Effect.void },
            fixture.preparation,
            fixture.policy,
            { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
            forbidden,
            'mutation autonomous cycle loop',
          ),
        ).pipe(Effect.flatten)
        const driver = yield* makeDriver
        yield* driver.advance
        expect(cyclePasses).toBe(1)
        unavailable = true
        yield* TestClock.adjust(1_000)
        const missing = yield* driver.advance
        expect(missing.observation).toMatchObject({ result: 'FAILURE', operation: 'reconcile' })
        expect(missing.nextDelayMs).toBe(scenario.fast ? 1_000 : undefined)
        expect(cyclePasses).toBe(1)
        if (scenario.fast) {
          const previousReads = reads
          yield* TestClock.adjust(1_000)
          const retry = yield* driver.advance
          expect(retry.nextDelayMs).toBe(Math.min(1_000, scenario.closeMs - 2_000))
          expect(reads).toBe(previousReads + 1)
          expect(cyclePasses).toBe(1)
          // A new driver cannot inherit the previous driver's exit continuation hint.
          const restarted = yield* makeDriver
          expect((yield* restarted.advance).nextDelayMs).toBeUndefined()
          if ('clearOnError' in scenario) {
            errorKind = BrokerReadErrorKind.Authentication
            errorMarked = false
            yield* TestClock.adjust(1_000)
            expect((yield* driver.advance).nextDelayMs).toBeUndefined()
            errorKind = BrokerReadErrorKind.Timeout
            errorMarked = true
            yield* TestClock.adjust(30_000)
            const previousReads = reads
            expect((yield* driver.advance).nextDelayMs).toBeUndefined()
            expect(reads).toBe(previousReads + 1)
            expect(cyclePasses).toBe(1)
            return
          }
          if (scenario.closeMs < 30_000) {
            yield* TestClock.adjust(1_000)
            expect((yield* driver.advance).nextDelayMs).toBeUndefined()
            expect(cyclePasses).toBe(1)
            return
          }
          unavailable = false
          yield* TestClock.adjust(1_000)
          yield* driver.advance
          expect(cyclePasses).toBe(2)
          // Successful reconciliation clears the hint; later absence is not a post-exit retry.
          unavailable = true
          yield* TestClock.adjust(30_000)
          expect((yield* driver.advance).nextDelayMs).toBeUndefined()
        }
      }).pipe(
        Effect.provideService(BrokerRead, {
          ...services.brokerRead,
          account: Effect.suspend(() => {
            reads += 1
            return unavailable
              ? Effect.fail(
                  new BrokerReadError({
                    operation: 'preflight',
                    kind: errorKind,
                    retryable: true,
                    message: 'synthetic missing cut',
                    ...(errorMarked ? { observationFailure: 'NO_ADMISSIBLE_CUT' as const } : {}),
                  }),
                )
              : services.brokerRead.account
          }),
        }),
        Effect.provideService(CycleStore, cycleStore),
        Effect.provideService(BrokerEventStore, services.executionStore),
        Effect.provideService(FillAccountingStore, services.executionStore),
        Effect.provideService(ValuationStore, services.executionStore),
        Effect.provideService(ReconciliationStore, services.executionStore),
        Effect.provideService(AuthorityGenerationStore, services.executionStore),
        Effect.provideService(AuthorityRestrictionStore, services.executionStore),
        Effect.provideService(IntentStore, {
          protectionForCycle: forbidden,
          beginProtectionCancel: forbidden,
          commit: forbidden,
          read: forbidden,
        }),
        Effect.provideService(MutationStore, {
          authorizeSubmit: forbidden,
          beginSubmit: forbidden,
          submitAccepted: forbidden,
          submitRejected: forbidden,
          submitDenied: forbidden,
          submitUnknown: forbidden,
          beginCancel: forbidden,
          cancelAccepted: forbidden,
          cancelUnknown: forbidden,
          recoveryFound: forbidden,
          recoveryNotFound: forbidden,
          recoveryUnknown: forbidden,
          latest: forbidden,
        }),
        Effect.provideService(WriterFence, services.writerFence),
        Effect.provideService(CandidateObservationStore, { record: forbidden, latestJevWindowEnd: forbidden }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
  } finally {
    pass.mockRestore()
  }
})

test('a pending broker cut waits without cycle or order I/O and rechecks expiry on the next pass', async () => {
  const fixture = await executionLifecycleFixture()
  const services = makeExactReconciliationServices(Authority.Execution)
  const passes: AutonomousCyclePassObservation[] = []
  let reads = 0
  let kind = BrokerReadErrorKind.ObservationPending
  const forbidden = () => Effect.die(new Error('an unavailable observation cannot acquire, bind or mutate'))
  const cycleStore: CycleStoreShape = {
    readOldestUnfinished: forbidden,
    acquire: forbidden,
    read: forbidden,
    readAuthoritySlot: forbidden,
    readDecisionDocument: forbidden,
    activate: forbidden,
    bindDecision: forbidden,
    finish: forbidden,
    block: forbidden,
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const driver = yield* Effect.fromResult(
        makeRecoveryFirstCycleDriver(
          fixture.input,
          {
            cycleBindingId: cycle.identity.qualificationRunId,
            recordPass: (pass) =>
              Effect.sync(() => {
                passes.push(pass)
              }),
          },
          fixture.preparation,
          fixture.policy,
          { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
          forbidden,
          'mutation autonomous cycle loop',
        ),
      ).pipe(Effect.flatten)
      const first = yield* driver.advance
      expect(first.observation).toMatchObject({
        result: 'SUCCESS',
        outcome: 'WAITING',
        waitReason: 'BROKER_OBSERVATION_PENDING',
      })
      expect('result' in first).toBe(false)
      expect(first.nextDelayMs).toBe(1_000)
      yield* TestClock.adjust(first.nextDelayMs ?? driver.nextDelayMs)
      const second = yield* driver.advance
      expect(reads).toBe(2)
      expect(second.nextDelayMs).toBe(1_000)
      kind = BrokerReadErrorKind.Timeout
      const expired = yield* driver.advance
      expect(expired.observation).toMatchObject({ result: 'FAILURE', operation: 'reconcile' })
      expect(expired.nextDelayMs).toBeUndefined()
      expect(reads).toBe(3)
      kind = BrokerReadErrorKind.RateLimited
      yield* TestClock.adjust(30_000)
      const rateLimited = yield* driver.advance
      expect(rateLimited.observation).toMatchObject({ result: 'FAILURE', operation: 'reconcile' })
      expect(rateLimited.nextDelayMs).toBeUndefined()
      expect(passes).toEqual([first.observation, second.observation, expired.observation, rateLimited.observation])
    }).pipe(
      Effect.provideService(BrokerRead, {
        ...services.brokerRead,
        account: Effect.suspend(() => {
          reads += 1
          return Effect.fail(
            new BrokerReadError({ operation: 'preflight', kind, retryable: true, message: `cache read ${kind}` }),
          )
        }),
      }),
      Effect.provideService(CycleStore, cycleStore),
      Effect.provideService(BrokerEventStore, services.executionStore),
      Effect.provideService(FillAccountingStore, services.executionStore),
      Effect.provideService(ValuationStore, services.executionStore),
      Effect.provideService(ReconciliationStore, services.executionStore),
      Effect.provideService(AuthorityGenerationStore, services.executionStore),
      Effect.provideService(AuthorityRestrictionStore, services.executionStore),
      Effect.provideService(IntentStore, {
        protectionForCycle: () => Effect.succeed([]),
        beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
        commit: forbidden,
        read: forbidden,
      }),
      Effect.provideService(MutationStore, {
        authorizeSubmit: forbidden,
        beginSubmit: forbidden,
        submitAccepted: forbidden,
        submitRejected: forbidden,
        submitDenied: forbidden,
        submitUnknown: forbidden,
        beginCancel: forbidden,
        cancelAccepted: forbidden,
        cancelUnknown: forbidden,
        recoveryFound: forbidden,
        recoveryNotFound: forbidden,
        recoveryUnknown: forbidden,
        latest: forbidden,
      }),
      Effect.provideService(WriterFence, services.writerFence),
      Effect.provideService(CandidateObservationStore, { record: forbidden, latestJevWindowEnd: forbidden }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )
})

test.each([
  [false, DecisionReadinessReason.SnapshotCoverage, undefined, undefined],
  [true, DecisionReadinessReason.SnapshotCoverage, undefined, undefined],
  [false, DecisionReadinessReason.SignalWindowObserved, 7_000, 7_000],
  [false, DecisionReadinessReason.LookbackWarmup, 7_000, 7_000],
  [false, DecisionReadinessReason.SignalWindowObserved, -1_000, undefined],
] as const)(
  'reuses preflight and retains waiting evidence for bound=%s reason=%s boundary=%s delay=%s',
  async (bound, reason, boundaryDelayMs, expectedNextDelayMs) => {
    const fixture = await executionLifecycleFixture()
    const services = makeExactReconciliationServices(Authority.Execution)
    let reconciliationWrites = 0
    const executionStore = {
      ...services.executionStore,
      reconcile: (accountId, snapshot) =>
        Effect.sync(() => {
          reconciliationWrites += 1
        }).pipe(Effect.andThen(services.executionStore.reconcile(accountId, snapshot))),
    } satisfies ReconciliationStoreShape
    const forbidden = () => Effect.die(new Error('waiting entry must not mutate or bind a cycle'))
    const store: CycleStoreShape = {
      readOldestUnfinished: () => Effect.succeed(Option.some(bound ? fixture.boundCycle : cycle)),
      acquire: forbidden,
      read: forbidden,
      readAuthoritySlot: forbidden,
      readDecisionDocument: () => (bound ? Effect.succeed(Option.some(fixture.document)) : forbidden()),
      activate: forbidden,
      bindDecision: forbidden,
      finish: forbidden,
      block: forbidden,
    }
    const readiness = {
      reason,
      message: 'intraday symbol lacks the complete rolling lookback baseline',
      symbol: 'IWM',
      ...(boundaryDelayMs === undefined
        ? {}
        : { availableAt: utcInstantFromEpochMillis(Date.parse(evaluatedAt) + boundaryDelayMs) }),
    }
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        const driver = yield* Effect.fromResult(
          makeRecoveryFirstCycleDriver(
            fixture.input,
            { cycleBindingId: cycle.identity.qualificationRunId, recordPass: () => Effect.void },
            fixture.preparation,
            fixture.policy,
            { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
            (_subject, reconcile) =>
              reconcile.pipe(
                Effect.mapError(
                  (cause) => new CycleDecisionBuildError({ failure: 'operational', message: cause.message, cause }),
                ),
                Effect.andThen(
                  Effect.fail(
                    new CycleDecisionBuildError({ failure: 'not-ready', message: readiness.message, readiness }),
                  ),
                ),
              ),
            'mutation autonomous cycle loop',
          ),
        ).pipe(Effect.flatten)
        const first = yield* driver.advance
        expect(first.observation).toMatchObject({
          result: 'SUCCESS',
          recoveryAction: 'WAITING',
          ...(bound ? { waitReason: 'reconciliation-not-later' } : { readiness }),
        })
        expect(first.nextDelayMs).toBe(expectedNextDelayMs)
        const firstCount = reconciliationWrites
        const second = yield* driver.advance
        expect(second.nextDelayMs).toBe(expectedNextDelayMs)
        const secondCount = reconciliationWrites
        yield* TestClock.adjust(30_000)
        const elapsed = yield* driver.advance
        expect(elapsed.nextDelayMs).toBeUndefined()
        return [firstCount, secondCount, reconciliationWrites]
      }).pipe(
        Effect.provideService(BrokerRead, services.brokerRead),
        Effect.provideService(CycleStore, store),
        Effect.provideService(BrokerEventStore, executionStore),
        Effect.provideService(FillAccountingStore, executionStore),
        Effect.provideService(ValuationStore, executionStore),
        Effect.provideService(ReconciliationStore, executionStore),
        Effect.provideService(AuthorityGenerationStore, executionStore),
        Effect.provideService(AuthorityRestrictionStore, executionStore),
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
          commit: (intent) =>
            bound
              ? Effect.succeed({
                  record: storedIntent(intent, IntentState.Terminal, evaluatedAt, TerminalOutcome.Filled),
                  deduplicated: true,
                })
              : forbidden(),
          read: (intentId) => {
            if (!bound) return forbidden()
            const intent = fixture.intents.find((item) => item.intentId === intentId)
            return Effect.succeed(
              intent === undefined
                ? Option.none()
                : Option.some(storedIntent(intent, IntentState.Terminal, evaluatedAt, TerminalOutcome.Filled)),
            )
          },
        }),
        Effect.provideService(MutationStore, {
          authorizeSubmit: forbidden,
          beginSubmit: forbidden,
          submitAccepted: forbidden,
          submitRejected: forbidden,
          submitDenied: forbidden,
          submitUnknown: forbidden,
          beginCancel: forbidden,
          cancelAccepted: forbidden,
          cancelUnknown: forbidden,
          recoveryFound: forbidden,
          recoveryNotFound: forbidden,
          recoveryUnknown: forbidden,
          latest: () => (bound ? Effect.as(Effect.void, undefined) : forbidden()),
        }),
        Effect.provideService(WriterFence, services.writerFence),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(counts).toEqual([1, 2, 3])
  },
)

test('entry expiry during reconciliation remains a non-dispatchable lifecycle result', async () => {
  const fixture = await executionLifecycleFixture()
  const cutoff = cycle.window.submissionCutoffAt
  let snapshots = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(cutoff) - 1)
      return yield* Effect.result(
        buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixture.preparation.executionModel,
          policy: fixture.policy,
          strategy: fixtureRuntime,
          reconcile: TestClock.setTime(Date.parse(cutoff)).pipe(Effect.as(reconciliationResultAt(cutoff))),
          intradayMarketData: {
            ...fixture.input.intradayMarketData,
            loadSnapshot: () =>
              Effect.sync(() => {
                snapshots += 1
              }).pipe(Effect.andThen(Effect.die('An expired entry must not read strategy inputs'))),
          },
        }).pipe(Effect.mapError(decisionBuildError)),
      )
    }).pipe((program) => provideDecisionServices(program, calendarRead([])), Effect.provide(TestClock.layer())),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      failure: 'not-ready',
      readiness: { reason: DecisionReadinessReason.NoEligibleCandidate },
    })
  expect(snapshots).toBe(0)
})

test.each([
  { field: 'peakEquityMicros', limit: 'maxDrawdownMicros', reason: 'DRAWDOWN_EXCEEDED', excess: 1n },
  { field: 'dayStartEquityMicros', limit: 'maxDailyLossMicros', reason: 'DAILY_LOSS_EXCEEDED', excess: 1n },
  { field: 'peakEquityMicros', limit: 'maxDrawdownMicros', reason: 'DRAWDOWN_EXCEEDED', excess: 0n },
  { field: 'dayStartEquityMicros', limit: 'maxDailyLossMicros', reason: 'DAILY_LOSS_EXCEEDED', excess: 0n },
] as const)('$reason entry protection retains the exact limit with $excess excess micros', async (entry) => {
  const fixture = await executionLifecycleFixture()
  const original = reconciliationResult(generationHash, Authority.Execution)
  const boundary =
    BigInt(original.brokerState.account.equityMicros) + BigInt(fixture.policy[entry.limit]) + entry.excess
  const facts = {
    ...original,
    riskContext: {
      ...original.riskContext,
      dayStartEquityMicros:
        entry.field === 'dayStartEquityMicros' ? boundary.toString() : original.riskContext.dayStartEquityMicros,
      peakEquityMicros: boundary.toString(),
    },
  }
  let snapshots = 0
  let batches = 0
  let calendarReads = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* Effect.result(
        buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixture.preparation.executionModel,
          policy: fixture.policy,
          strategy: fixtureRuntime,
          reconcile: Effect.succeed(facts),
          intradayMarketData: {
            ...fixture.input.intradayMarketData,
            loadSnapshot: (query) => {
              snapshots++
              return fixture.input.intradayMarketData.loadSnapshot(query)
            },
          },
        }).pipe(
          Effect.mapError(decisionBuildError),
          Effect.provideService(JevBatchStore, {
            read: () => Effect.die('Unexpected batch read'),
            pending: () => Effect.succeed([]),
            begin: (plan) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  batches++
                  return {
                    plan,
                    dispatches: [],
                    result: nativeJevBatchResult(plan, utcInstantFromEpochMillis(now), () => 'enter'),
                  }
                }),
              ),
            finish: () => Effect.die('Unexpected batch finish'),
          }),
        ),
      )
    }).pipe(
      (program) =>
        provideDecisionServices(program, (query) => {
          calendarReads++
          return entry.excess > 0n
            ? Effect.die('A protected entry must not request the calendar')
            : calendarRead([])(query)
        }),
      Effect.provide(TestClock.layer()),
    ),
  )
  if (entry.excess > 0n) {
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        failure: 'not-ready',
        readiness: {
          reason: DecisionReadinessReason.AccountProtection,
          message: expect.stringContaining(entry.reason),
        },
      })
      expect(result.failure).not.toHaveProperty('readiness.accountProtectionReasons')
    }
    expect(snapshots).toBe(0)
    expect(batches).toBe(0)
    expect(calendarReads).toBe(0)
  } else {
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(result.success.riskBlock).toBeUndefined()
    expect(snapshots).toBeGreaterThan(0)
    expect(batches).toBeGreaterThan(0)
    expect(calendarReads).toBeGreaterThan(0)
  }
})

test('account drawdown does not suppress read-only strategy observations', async () => {
  const fixture = await executionLifecycleFixture()
  const original = reconciliationResult(generationHash, Authority.Observe)
  const policy = await Effect.runPromise(loadExecutionRiskPolicy(accountId, fixtureProtocol.universe))
  let snapshots = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* Effect.result(
        buildObserveCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixture.preparation.executionModel,
          policy,
          strategy: fixtureRuntime,
          reconcile: Effect.succeed({
            ...original,
            riskContext: {
              ...original.riskContext,
              peakEquityMicros: (
                BigInt(original.brokerState.account.equityMicros) +
                BigInt(policy.maxDrawdownMicros) +
                1n
              ).toString(),
            },
          }),
          intradayMarketData: {
            ...fixture.input.intradayMarketData,
            loadSnapshot: (query) => {
              snapshots++
              return fixture.input.intradayMarketData.loadSnapshot(query)
            },
          },
        }),
      )
    }).pipe((program) => provideDecisionServices(program, calendarRead([])), Effect.provide(TestClock.layer())),
  )
  expect(Result.isSuccess(result)).toBe(true)
  expect(snapshots).toBeGreaterThan(0)
})

const withAdmissionDrawdown = (facts: ReconciliationPassResult, policy: Policy): ReconciliationPassResult => ({
  ...facts,
  riskContext: {
    ...facts.riskContext,
    peakEquityMicros: (
      BigInt(facts.brokerState.account.equityMicros) +
      BigInt(policy.maxDrawdownMicros) +
      1n
    ).toString(),
  },
})

test('flat admission protection preserves exact limit boundaries and resumes from new preflight facts', async () => {
  const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentIntradayRuntime))
  const original = reconciliationResultAt(evaluatedAt)
  const equity = BigInt(original.brokerState.account.equityMicros)
  for (const excess of [0n, 1n]) {
    for (const field of ['dayStartEquityMicros', 'peakEquityMicros'] as const) {
      const limit = field === 'dayStartEquityMicros' ? policy.maxDailyLossMicros : policy.maxDrawdownMicros
      const facts = {
        ...original,
        riskContext: { ...original.riskContext, [field]: (equity + BigInt(limit) + excess).toString() },
      }
      const result = protectedAccountAdmission(facts, policy, generationHash, evaluatedAt)
      if (excess === 0n) expect(result).toBeUndefined()
      else {
        expect(result).toMatchObject({
          outcome: 'ADMISSION_WAITING',
          readiness: {
            reason: DecisionReadinessReason.AccountProtection,
            message: expect.stringContaining(
              field === 'dayStartEquityMicros' ? 'DAILY_LOSS_EXCEEDED' : 'DRAWDOWN_EXCEEDED',
            ),
          },
          admissionProtection: {
            authorityGenerationHash: generationHash,
            reconciliationId: original.report.reconciliation.reconciliationId,
            tradingDate: executionDate,
            validUntil: utcInstantFromEpochMillis(Date.parse(evaluatedAt) + policy.maxBrokerStateAgeMs),
          },
        })
        expect(result).not.toHaveProperty('readiness.accountProtectionReasons')
      }
    }
  }
  expect(
    protectedAccountAdmission(withAdmissionDrawdown(original, policy), policy, generationHash, evaluatedAt),
  ).toBeDefined()
  expect(
    protectedAccountAdmission(reconciliationResultAt(evaluatedAt), policy, generationHash, evaluatedAt),
  ).toBeUndefined()
  const both = {
    ...withAdmissionDrawdown(original, policy),
    riskContext: {
      ...withAdmissionDrawdown(original, policy).riskContext,
      dayStartEquityMicros: (equity + BigInt(policy.maxDailyLossMicros) + 1n).toString(),
    },
  }
  expect(protectedAccountAdmission(both, policy, generationHash, evaluatedAt)?.readiness.message).toBe(
    'Existing account limits block new entries: DAILY_LOSS_EXCEEDED, DRAWDOWN_EXCEEDED',
  )
})

test('admission protection requires exact current flat, settled and generation-bound evidence', async () => {
  const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentIntradayRuntime))
  const facts = withAdmissionDrawdown(reconciliationResultAt(evaluatedAt), policy)
  const authority = facts.riskContext.authority
  if (authority === null) throw new Error('fixture requires authority')
  const unavailable: readonly (ReconciliationPassResult | undefined)[] = [
    undefined,
    { ...facts, riskContext: { ...facts.riskContext, unknownMutationCount: 1 } },
    { ...facts, riskContext: { ...facts.riskContext, authority: null, authorityObservedAt: null } },
    { ...facts, riskContext: { ...facts.riskContext, authority: { ...authority, generationHash: 'f'.repeat(64) } } },
    {
      ...facts,
      riskContext: {
        ...facts.riskContext,
        authority: { ...authority, maximum: Authority.Observe, effective: Authority.Observe },
      },
    },
    {
      ...facts,
      riskContext: {
        ...facts.riskContext,
        authority: { ...authority, effective: Authority.Observe, kill: KillState.Active },
      },
    },
    {
      ...facts,
      riskContext: {
        ...facts.riskContext,
        authorityObservedAt: utcInstantFromEpochMillis(Date.parse(evaluatedAt) + 1),
      },
    },
    { ...facts, report: { ...facts.report, metrics: { ...facts.report.metrics, accountingExact: false } } },
    {
      ...facts,
      report: {
        ...facts.report,
        reconciliation: { ...facts.report.reconciliation, status: ReconciliationStatus.Discrepancy },
      },
    },
    { ...facts, brokerState: { ...facts.brokerState, unknownOrderCount: 1 } },
    {
      ...facts,
      brokerState: { ...facts.brokerState, account: { ...facts.brokerState.account, accountId: 'foreign-account' } },
    },
    {
      ...facts,
      brokerState: {
        ...facts.brokerState,
        reconciliation: { ...facts.brokerState.reconciliation, expectedHash: 'f'.repeat(64) },
      },
    },
  ]
  for (const candidate of unavailable)
    expect(protectedAccountAdmission(candidate, policy, generationHash, evaluatedAt)).toBeUndefined()
  expect(
    protectedAccountAdmission(
      facts,
      policy,
      generationHash,
      utcInstantFromEpochMillis(Date.parse(evaluatedAt) + policy.maxBrokerStateAgeMs),
    ),
  ).toBeUndefined()
  const positions: readonly Position[] = [
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'NVDA',
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '100000000',
      costBasisMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '0',
      observedAt: evaluatedAt,
    },
  ]
  const order: Order = {
    schemaVersion: 'bayn.order.v3',
    accountId,
    brokerOrderId: 'pending-admission-order',
    clientOrderId: 'pending-admission-client',
    symbol: 'NVDA',
    side: OrderSide.Buy,
    orderType: OrderType.Limit,
    timeInForce: TimeInForce.Day,
    quantityAtoms: '1000000000',
    filledQuantityAtoms: '0',
    limitPriceMicros: '100000000',
    status: OrderStatus.New,
    observedAt: evaluatedAt,
  }
  for (const candidate of [
    reconciliationResultAt(evaluatedAt, 0, 0, positions),
    reconciliationResultAt(evaluatedAt, 0, 0, [], [order]),
  ])
    expect(
      protectedAccountAdmission(withAdmissionDrawdown(candidate, policy), policy, generationHash, evaluatedAt),
    ).toBeUndefined()
  const beforeMidnight = '2020-05-02T03:59:59.999Z'
  const priorDate = withAdmissionDrawdown(reconciliationResultAt(beforeMidnight), policy)
  expect(protectedAccountAdmission(priorDate, policy, generationHash, beforeMidnight)).toBeDefined()
  expect(protectedAccountAdmission(priorDate, policy, generationHash, '2020-05-02T04:00:00.000Z')).toBeUndefined()
})

test.each(['empty', 'expired', 'bound'] as const)(
  'protected %s account preserves recovery priority without new cycle writes',
  async (kind) => {
    const fixture = await executionLifecycleFixture()
    const services = makeExactReconciliationServices(Authority.Execution)
    const at = kind === 'expired' ? utcInstantFromEpochMillis(unusedEntryExpiresAt(cycle)) : evaluatedAt
    const calls: string[] = []
    const forbidden = () =>
      Effect.die('Protected admission must not acquire, activate, read strategy data or mutate the broker')
    const store: CycleStoreShape = {
      readOldestUnfinished: () =>
        Effect.sync(() => {
          calls.push('unfinished')
          return kind === 'empty' ? Option.none() : Option.some(kind === 'bound' ? fixture.boundCycle : cycle)
        }),
      readDecisionDocument: () =>
        Effect.sync(() => {
          calls.push('bound-recovery')
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new CycleStoreError({
                operation: 'read-decision-document',
                failure: 'query',
                message: 'bound recovery sentinel',
              }),
            ),
          ),
        ),
      block: (_id, reason, observedAt) =>
        Effect.sync(() => {
          calls.push('expire')
          expect(reason).toBe(CycleTerminalReason.UnusedEntryExpired)
          return {
            cycle: {
              ...cycle,
              state: CycleState.Blocked,
              terminalReason: reason,
              updatedAt: observedAt,
              terminalAt: observedAt,
            },
            changed: true,
          }
        }),
      acquire: forbidden,
      activate: forbidden,
      read: forbidden,
      readAuthoritySlot: forbidden,
      bindDecision: forbidden,
      finish: forbidden,
    }
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const results = []
        for (let index = 0; index < (kind === 'empty' ? 3 : 1); index++) {
          const observedAt = utcInstantFromEpochMillis(Date.parse(at) + index * 35_000)
          yield* TestClock.setTime(Date.parse(observedAt))
          results.push(
            yield* Effect.result(
              runRecoveryFirstCyclePass(
                fixture.input,
                fixture.policy,
                {
                  cycleBindingId: cycle.identity.qualificationRunId,
                  accountId,
                  strategyName: 'jev',
                  strategyProtocolHash: fixture.preparation.strategyProtocolHash,
                  executionPolicy: fixture.preparation.executionPolicy,
                  buildDecision: forbidden,
                  buildDecisionEvidence: forbidden,
                },
                { read: forbidden(), refresh: forbidden() },
                { _tag: 'Mutation', executionProgram: fixture.input.executionProgram },
                withAdmissionDrawdown(reconciliationResultAt(observedAt), fixture.policy),
              ),
            ),
          )
        }
        return results
      }).pipe(
        Effect.provideService(CycleStore, store),
        Effect.provideService(BrokerRead, decisionBrokerRead(forbidden)),
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
          commit: forbidden,
          read: forbidden,
        }),
        Effect.provideService(MutationStore, {} as MutationStoreShape),
        Effect.provideService(AuthorityGenerationStore, unusedAuthorityStore),
        Effect.provideService(AuthorityRestrictionStore, { restrictAuthority: forbidden }),
        Effect.provideService(BrokerEventStore, services.executionStore),
        Effect.provideService(FillAccountingStore, services.executionStore),
        Effect.provideService(ValuationStore, services.executionStore),
        Effect.provideService(ReconciliationStore, services.executionStore),
        Effect.provideService(WriterFence, services.writerFence),
        Effect.provideService(CandidateObservationStore, { record: forbidden, latestJevWindowEnd: forbidden }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
    if (kind === 'empty') {
      expect(calls).toEqual(['unfinished', 'unfinished', 'unfinished'])
      for (const result of results)
        expect(result).toMatchObject({ _tag: 'Success', success: { outcome: 'ADMISSION_WAITING' } })
    } else if (kind === 'expired') {
      expect(calls).toEqual(['unfinished', 'expire'])
      expect(results[0]).toMatchObject({ _tag: 'Success', success: { outcome: 'RECOVERED', action: 'BLOCKED' } })
    } else {
      expect(calls).toEqual(['unfinished', 'bound-recovery'])
      expect(results[0]).toMatchObject({ _tag: 'Failure', failure: { operation: 'recover-cycle' } })
    }
  },
)

test('cycle-free protection keeps reconciliation and projection checks on the existing driver cadence', async () => {
  const fixture = await executionLifecycleFixture()
  const services = makeExactReconciliationServices(Authority.Execution)
  let reconciliationWrites = 0
  let reconciliationRecords = 0
  let unfinishedReads = 0
  let projectionChecks = 0
  const passes: AutonomousCyclePassObservation[] = []
  const forbidden = () => Effect.die('Protected driver must not acquire, activate, infer or mutate')
  const executionStore = {
    ...services.executionStore,
    readAuthorityState: forbidden(),
    reconcile: (accountId, snapshot) =>
      services.executionStore.reconcile(accountId, snapshot).pipe(
        Effect.map((result) => {
          reconciliationWrites += 1
          return {
            ...result,
            persisted: {
              ...result.persisted,
              riskContext: {
                ...result.persisted.riskContext,
                peakEquityMicros: (
                  BigInt(account.equityMicros) +
                  BigInt(fixture.policy.maxDrawdownMicros) +
                  1n
                ).toString(),
              },
            },
          }
        }),
      ),
  } satisfies ReconciliationStoreShape & AuthorityGenerationStoreShape
  const store: CycleStoreShape = {
    readOldestUnfinished: () =>
      Effect.sync(() => {
        unfinishedReads += 1
        return Option.none()
      }),
    acquire: forbidden,
    activate: forbidden,
    read: forbidden,
    readAuthoritySlot: forbidden,
    readDecisionDocument: forbidden,
    bindDecision: forbidden,
    finish: forbidden,
    block: forbidden,
  }
  const executionProgram: ExecutionProgram = {
    ...fixture.input.executionProgram,
    recordReconciliation: () =>
      Effect.sync(() => {
        reconciliationRecords += 1
      }),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      const driver = yield* Effect.fromResult(
        makeRecoveryFirstCycleDriver(
          {
            ...fixture.input,
            intradayMarketData: {
              check: Effect.sync(() => {
                projectionChecks += 1
              }),
              loadSnapshot: forbidden,
              verifyReference: forbidden,
            },
          },
          {
            cycleBindingId: cycle.identity.qualificationRunId,
            recordPass: (pass) =>
              Effect.sync(() => {
                passes.push(pass)
              }),
          },
          fixture.preparation,
          fixture.policy,
          { _tag: 'Mutation', executionProgram },
          forbidden,
          'mutation autonomous cycle loop',
        ),
      ).pipe(Effect.flatten)
      expect(driver.nextDelayMs).toBe(30_000)
      for (let index = 0; index < 3; index++) {
        const result = yield* driver.advance
        expect(result.observation).toMatchObject({
          result: 'SUCCESS',
          outcome: 'ADMISSION_WAITING',
          readiness: { reason: DecisionReadinessReason.AccountProtection },
        })
        expect(result.nextDelayMs ?? driver.nextDelayMs).toBe(30_000)
        expect([reconciliationWrites, reconciliationRecords, unfinishedReads, projectionChecks, passes.length]).toEqual(
          Array(5).fill(index + 1),
        )
        yield* TestClock.adjust(driver.nextDelayMs)
      }
    }).pipe(
      Effect.provideService(BrokerRead, services.brokerRead),
      Effect.provideService(CycleStore, store),
      Effect.provideService(BrokerEventStore, executionStore),
      Effect.provideService(FillAccountingStore, executionStore),
      Effect.provideService(ValuationStore, executionStore),
      Effect.provideService(ReconciliationStore, executionStore),
      Effect.provideService(AuthorityGenerationStore, executionStore),
      Effect.provideService(AuthorityRestrictionStore, executionStore),
      Effect.provideService(WriterFence, services.writerFence),
      Effect.provideService(IntentStore, {
        protectionForCycle: () => Effect.succeed([]),
        beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
        commit: forbidden,
        read: forbidden,
      }),
      Effect.provideService(MutationStore, {} as MutationStoreShape),
      Effect.provideService(CandidateObservationStore, { record: forbidden, latestJevWindowEnd: forbidden }),
      provideJevTestServices,
      Effect.provide(TestClock.layer()),
    ),
  )
})

// Native orders remain owned by the same account controller, including after an entry parent settles.
test.each(['known', 'unknown', 'filled', 'unaccounted'] as const)(
  'native protection resolves cancellation or a completed disposal: %s',
  async (mode) => {
    const unknown = mode === 'unknown'
    const flat = mode === 'filled' || mode === 'unaccounted'
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const decision = fixture.document.strategyDecision
    if (decision?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Entry fixture required')
    const levels = decision.exitPolicy.plans[fixture.intent.symbol]?.levels
    if (levels === undefined) throw new Error('Bound strategy prices required')
    const intent = await Effect.runPromise(
      planExecutionIntent(
        {
          schemaVersion: 'bayn.intent-plan.v3',
          strategyName: 'jev',
          cycleId: fixture.intent.cycleId,
          decisionHash: fixture.intent.decisionHash,
          policyHash: fixture.intent.policyHash,
          accountId,
          symbol: fixture.intent.symbol,
          quantityAtoms: fixture.intent.quantityAtoms,
          timeInForce: TimeInForce.Day,
          side: OrderSide.Sell,
          orderType: OrderType.StopLimit,
          limitPriceMicros: levels.stopLimitPriceMicros,
          notionalLimitMicros: String(
            (BigInt(fixture.intent.quantityAtoms) * BigInt(levels.stopLimitPriceMicros)) / 1_000_000_000n,
          ),
          protection: {
            _tag: 'StopLimit',
            stopPriceMicros: levels.stopPriceMicros,
            entryDecisionHash: fixture.document.contentHash,
          },
          createdAt: observedAt,
        },
        {
          authority: {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash,
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
            version: 1,
            updatedAt: observedAt,
          },
        },
      ),
    )
    const held = flat
      ? storedIntent(intent, IntentState.Terminal, observedAt, TerminalOutcome.Filled)
      : storedIntent(intent, IntentState.Acknowledged, observedAt)
    const root = storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Filled)
    const order: Order = {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'known-protective-order',
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      symbol: intent.symbol,
      side: OrderSide.Sell,
      orderType: OrderType.StopLimit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: intent.quantityAtoms,
      filledQuantityAtoms: flat ? intent.quantityAtoms : '0',
      limitPriceMicros: intent.limitPriceMicros,
      stopPriceMicros: levels.stopPriceMicros,
      status: flat ? OrderStatus.Filled : OrderStatus.New,
      observedAt,
    }
    const submit: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '6'.repeat(64),
      mutationId: '7'.repeat(64),
      intentId: intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '8'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: order.brokerOrderId,
      occurredAt: observedAt,
    }
    const calls: string[] = []
    const unused = Effect.die('Cancellation cannot submit or change the position')
    const program = {
      ...sandboxExecutionProgram(),
      cancelProtectionOrder: (owner: string, brokerOrderId: string) =>
        Effect.gen(function* () {
          calls.push(`${owner}:${brokerOrderId}`)
          if (unknown)
            return yield* new BrokerMutationError({
              operation: MutationOperation.Cancel,
              failure: MutationFailure.Unknown,
              outcome: MutationOutcome.Unknown,
              message: 'injected ambiguous cancellation',
            })
          return true
        }),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* advancePositionProtection({
          input: fixture.input,
          cycle: fixture.boundCycle,
          document: fixture.document,
          protocol: currentIntradayProtocol,
          policy: fixture.policy,
          reconciliation: (() => {
            const facts = reconciliationResultAt(observedAt, 0, 0, [], [order])
            return mode !== 'unaccounted'
              ? facts
              : { ...facts, report: { ...facts.report, metrics: { ...facts.report.metrics, accountingExact: false } } }
          })(),
          capability: { _tag: 'Mutation', executionProgram: program },
          closeDue: false,
          closeExpiresAt: fixture.boundCycle.window.executionCloseAt,
        })
      }).pipe(
        Effect.provideService(IntentStore, {
          read: (id) => Effect.succeed(Option.some(id === intent.intentId ? held : root)),
          protectionForCycle: () => Effect.succeed([held]),
          beginProtectionCancel: () => unused,
          commit: () => unused,
        }),
        Effect.provideService(MutationStore, {
          latest: (_id, operation) => Effect.succeed(operation === MutationOperation.Submit ? submit : undefined),
          authorizeSubmit: () => unused,
          beginSubmit: () => unused,
          submitAccepted: () => unused,
          submitRejected: () => unused,
          submitDenied: () => unused,
          submitUnknown: () => unused,
          beginCancel: () => unused,
          cancelAccepted: () => unused,
          cancelUnknown: () => unused,
          recoveryFound: () => unused,
          recoveryNotFound: () => unused,
          recoveryUnknown: () => unused,
        }),
        provideJevTestServices,
        Effect.provide(TestClock.layer()),
      ),
    )
    if (flat) {
      expect(result).toEqual({
        _tag: 'Step',
        step:
          mode === 'filled'
            ? { _tag: 'Complete', observedAt }
            : { _tag: 'Wait', observedAt, waitReason: 'PROTECTION_AWAITING_RECONCILIATION' },
      })
      expect(calls).toEqual([])
    } else {
      expect(result._tag).toBe('PostMutationReconciliation')
      expect(calls).toEqual([`${intent.intentId}:${order.brokerOrderId}`])
    }
  },
)
