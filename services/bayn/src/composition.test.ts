import { describe, expect, test } from 'bun:test'

import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Redacted,
  Ref,
  References,
  Result,
} from 'effect'
import { TestClock } from 'effect/testing'

import {
  config,
  fixtureRuntime,
  marketDataService,
  pinnedEvaluation,
  pinnedRuntime,
  pinnedRuntimeConfig,
  pinnedStore,
  readyState,
  successfulJournal,
} from './app-test-support'
import {
  advanceRestrictedGenerationRecovery,
  executionObserveSuccessorGenerationHash,
  recoverTerminalGenerationToObserve,
  recoverRestrictedGenerationBeforeRollover,
} from './blocked-generation-recovery'
import { provideTestLayer } from './effect-test-support'

import {
  ApplicationPlatformLive,
  QualifiedCapitalActivationStoreLive,
  activatePreparedQualifiedCapitalGeneration,
  closedCycleReceiptEmissionAllowed,
  decideExecutionLifecycleMaintenance,
  finalizeExecutionEpisode,
  observeCycleGenerationHash,
  capitalReceiptFinalizationWindowOpen,
  prepareOrRecoverQualifiedCapitalActivation,
  prepareOrRecoverResearchCapitalActivation,
  readCompletedExecutionLifecycle,
  recoverCapitalActivationGeneration,
  refreshResearchCapitalActivationReconciliation,
  restrictExpiredCapitalActivation,
  runExecutionLifecycleMaintenance,
  runRestateLifecycleWithReconciliationGuardian,
} from './composition'
import { makeApplicationPlan, type ApplicationPlanFor } from './app'
import { AccountStatus, alpacaSandboxBaseUrl, type BrokerSessionShape } from './broker/alpaca'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from './broker/identity'
import { makeStrategyProtocolHash } from './contracts'
import { DatabaseError } from './db/evidence-store'
import {
  CapitalGrantLifecycleStore,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type CapitalGrantLifecycleStoreShape,
} from './db/execution-store'
import { BrokerAccess, noCapitalAuthority } from './execution/authority'
import {
  capitalActivationRequiresQualificationEvidence,
  makeResearchCapitalActivationRequest,
  makeCapitalActivationRequest,
  makeResearchCapitalBuildContinuation,
  makeResearchCapitalPlanHash,
} from './execution/configuration'
import {
  Authority,
  KillState,
  makeCapitalGrantGenerationResult,
  makeResearchCapitalGrantGenerationResult,
  type AuthorityState,
} from './execution/contracts'
import { BlockedCycleIntentStoreError, type BlockedCycleIntentStoreShape } from './execution/intents'
import type { WriterFenceService } from './execution/writer-fence'
import { OperationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { loadObserveRiskPolicy, executionEpisodeReceiptFinalizationExpiresAt } from './observe-composition'
import { runLifecycleMaintenanceAdvance } from './composition/lifecycle'
import {
  readOnlyExecutionControllerBinding,
  readOnlyCycleObservationId,
  readOnlyQualificationEvidenceRequired,
  refreshReadOnlyCapitalActivation,
  refreshReadOnlyQualification,
  resolveReadOnlyCycleObservationId,
  resolveReadOnlyCycleObservationIdForHealth,
} from './composition/read-only-status'
import { executionControllerConfig } from './composition/native-execution-runtime'
import { ReconciliationError } from './reconciler'
import { initialState, type RuntimeEvidence } from './runtime-state'
import { fixtureProtocol } from './test-fixtures'

const hash = (value: string) => value.repeat(64).slice(0, 64)

const researchPlan = {
  schemaVersion: 'bayn.paper-research-plan.v1' as const,
  activation: {
    sourceRevision: '3'.repeat(40),
    imageRepository: 'registry.example.test/bayn',
    imageDigest: `sha256:${hash('4')}`,
  },
  strategy: {
    name: 'risk-balanced-trend',
    behaviorHash: hash('5'),
    parameterHash: hash('6'),
    parameterSchemaVersion: 'bayn.robust-trend-parameters.v2',
    protocolHash: hash('7'),
  },
  broker: {
    environment: BrokerEnvironment.Sandbox,
    accountId: 'paper-account',
    identityHash: hash('8'),
  },
  riskPolicyHash: hash('9'),
  limits: { maxOpenOrders: 0 as const, maxPositions: 0 as const },
  cutoffAt: '2026-09-01T13:30:00.000Z',
  expiresAt: '2026-09-03T20:00:00.000Z',
  maximumCloseSessions: 3 as const,
} as const
const { schemaVersion: _researchPlanSchemaVersion, ...researchPlanFields } = researchPlan

const researchRequest = Result.getOrThrow(
  makeResearchCapitalActivationRequest({
    schemaVersion: 'bayn.paper-research-activation-request.v1',
    grant: { _tag: 'Research', planHash: Result.getOrThrow(makeResearchCapitalPlanHash(researchPlan)) },
    ...researchPlanFields,
  }),
)

const continuationAccountId = 'paper-continuation-account'
const continuationSourceGenerationHash = hash('a')
const continuationBrokerIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: continuationAccountId,
  }),
)
const continuationStrategyProtocolHash = makeStrategyProtocolHash(fixtureRuntime.provenance.strategy)
const continuationResearchPlan = {
  schemaVersion: 'bayn.paper-research-plan.v1' as const,
  activation: {
    sourceRevision: config.build.sourceRevision,
    imageRepository: config.build.imageRepository,
    imageDigest: config.build.imageDigest,
  },
  strategy: {
    name: fixtureRuntime.provenance.strategy.name,
    behaviorHash: fixtureRuntime.provenance.strategy.behaviorHash,
    parameterHash: fixtureRuntime.provenance.strategy.parameterHash,
    parameterSchemaVersion: fixtureRuntime.provenance.strategy.parameterSchemaVersion,
    protocolHash: continuationStrategyProtocolHash,
  },
  broker: {
    environment: BrokerEnvironment.Sandbox,
    accountId: continuationAccountId,
    identityHash: continuationBrokerIdentity.identityHash,
  },
  riskPolicyHash: hash('b'),
  limits: { maxOpenOrders: 0 as const, maxPositions: 0 as const },
  cutoffAt: '2026-09-01T13:30:00.000Z',
  expiresAt: '2026-09-03T20:00:00.000Z',
  maximumCloseSessions: 3 as const,
} as const
const { schemaVersion: _continuationPlanSchemaVersion, ...continuationResearchPlanFields } = continuationResearchPlan
const continuationRequest = Result.getOrThrow(
  makeResearchCapitalActivationRequest({
    schemaVersion: 'bayn.paper-research-activation-request.v1',
    grant: {
      _tag: 'Research',
      planHash: Result.getOrThrow(makeResearchCapitalPlanHash(continuationResearchPlan)),
    },
    ...continuationResearchPlanFields,
  }),
)
const continuationGeneration = Result.getOrThrow(
  makeResearchCapitalGrantGenerationResult({
    schemaVersion: 'bayn.paper-authority-generation.v3',
    maximum: Authority.Execution,
    previousGenerationHash: continuationSourceGenerationHash,
    grant: continuationRequest.grant,
    activationSourceRevision: continuationRequest.activation.sourceRevision,
    activationImageRepository: continuationRequest.activation.imageRepository,
    activationImageDigest: continuationRequest.activation.imageDigest,
    strategyName: continuationRequest.strategy.name,
    strategyBehaviorHash: continuationRequest.strategy.behaviorHash,
    strategyParameterHash: continuationRequest.strategy.parameterHash,
    strategyParameterSchemaVersion: continuationRequest.strategy.parameterSchemaVersion,
    strategyProtocolHash: continuationRequest.strategy.protocolHash,
    accountId: continuationRequest.broker.accountId,
    brokerIdentityHash: continuationRequest.broker.identityHash,
    riskPolicyHash: continuationRequest.riskPolicyHash,
    proofPlanHash: continuationRequest.grant.planHash,
    reconciliationId: hash('c'),
    reconciliationContentHash: hash('d'),
  }),
)
const continuationBuild = {
  sourceRevision: 'e'.repeat(40),
  imageRepository: continuationRequest.activation.imageRepository,
  imageDigest: `sha256:${hash('f')}`,
} as const
const researchBuildContinuation = Result.getOrThrow(
  makeResearchCapitalBuildContinuation({
    schemaVersion: 'bayn.paper-research-build-continuation.v1',
    request: continuationRequest,
    generationHash: continuationGeneration.generationHash,
    activation: continuationBuild,
  }),
)
const mismatchedResearchBuildContinuation = Result.getOrThrow(
  makeResearchCapitalBuildContinuation({
    schemaVersion: 'bayn.paper-research-build-continuation.v1',
    request: continuationRequest,
    generationHash: hash('0'),
    activation: continuationBuild,
  }),
)
const staleResearchBuildContinuation = Result.getOrThrow(
  makeResearchCapitalBuildContinuation({
    schemaVersion: 'bayn.paper-research-build-continuation.v1',
    request: continuationRequest,
    generationHash: continuationGeneration.generationHash,
    activation: {
      ...continuationBuild,
      sourceRevision: '0'.repeat(40),
      imageDigest: `sha256:${hash('1')}`,
    },
  }),
)
const continuationApplicationPlan: ApplicationPlanFor<'AutonomousService'> = (() => {
  const plan = makeApplicationPlan({
    config: {
      ...config,
      runtimeMode: 'AutonomousService',
      lifecycleOwner: config.lifecycleOwner ?? 'Process',
      lifecycleCommandPort: config.lifecycleCommandPort ?? 8081,
      lifecycleControllerKey: config.lifecycleControllerKey ?? 'primary',
      cyclePollIntervalMs: 30_000,
      execution: {
        brokerIdentity: continuationBrokerIdentity,
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: noCapitalAuthority,
      },
      build: { ...config.build, ...continuationBuild },
      alpaca: {
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        identity: continuationBrokerIdentity,
        baseUrl: alpacaSandboxBaseUrl,
        expectedAccountId: continuationAccountId,
        authorityGenerationHash: continuationSourceGenerationHash,
        key: Redacted.make('test-key'),
        secret: Redacted.make('test-secret'),
        proxyUrl: 'http://proxy.test:3128',
        operationTimeoutMs: config.operationTimeoutMs,
        retryAttempts: 0,
        reconciliationIntervalMs: 30_000,
      },
    },
    protocol: fixtureProtocol,
    parameterHash: fixtureRuntime.provenance.strategy.parameterHash,
    strategy: fixtureRuntime,
    strategyProtocolHash: continuationStrategyProtocolHash,
  })
  if (plan._tag !== 'AutonomousService') throw new Error('continuation fixture must produce AutonomousService')
  return plan
})()
const pinnedStatusApplicationPlan: ApplicationPlanFor<'AutonomousService'> = (() => {
  const plan = makeApplicationPlan({
    config: {
      ...continuationApplicationPlan.config,
      qualificationRunId: pinnedEvaluation.runId,
      build: pinnedRuntimeConfig.build,
      clickhouse: pinnedRuntimeConfig.clickhouse,
    },
    protocol: fixtureProtocol,
    parameterHash: pinnedRuntime.provenance.strategy.parameterHash,
    strategy: pinnedRuntime,
    strategyProtocolHash: makeStrategyProtocolHash(pinnedRuntime.provenance.strategy),
  })
  if (plan._tag !== 'AutonomousService') throw new Error('pinned status fixture must produce AutonomousService')
  return plan
})()
const continuationAuthority: AuthorityState = {
  schemaVersion: 'bayn.paper-authority.v1',
  generationHash: continuationGeneration.generationHash,
  maximum: Authority.Execution,
  effective: Authority.Execution,
  kill: KillState.Clear,
  version: 2,
  updatedAt: '2026-08-10T18:00:00.000Z',
}

const continuationAuthorityStore = (
  generation: typeof continuationGeneration | null = continuationGeneration,
  authority: AuthorityState = continuationAuthority,
): AuthorityGenerationStoreShape => ({
  ensureAuthorityGeneration: () => Effect.die(new Error('build continuation must not rearm authority')),
  readAuthorityState: Effect.succeed(authority),
  readResearchAuthorityGeneration: (generationHash) =>
    Effect.succeed(generation?.generationHash === generationHash ? generation : undefined),
})

const unusedCapitalGrantLifecycle: CapitalGrantLifecycleStoreShape = {
  prepareCapitalGrant: () => Effect.die(new Error('build continuation must not prepare authority')),
  activateCapitalGrant: () => Effect.die(new Error('build continuation must not activate qualified authority')),
  activatePreparedCapitalGrant: () =>
    Effect.die(new Error('build continuation must not activate prepared qualified authority')),
  activateResearchCapitalGrant: () => Effect.die(new Error('build continuation must not activate research authority')),
}

const unusedBrokerSession = {} as BrokerSessionShape
const unusedAuthorityRestrictionStore: AuthorityRestrictionStoreShape = {
  restrictAuthority: () => Effect.die(new Error('active close lease must not restrict authority')),
}
const unusedWriterFence: WriterFenceService = {
  backendPid: 1,
  check: Effect.void,
  transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
}

const resumeBuildContinuation = (
  continuation = researchBuildContinuation,
  authorityStore = continuationAuthorityStore(),
) =>
  prepareOrRecoverResearchCapitalActivation(
    continuationApplicationPlan,
    continuationRequest,
    continuation,
    unusedBrokerSession,
    authorityStore,
    unusedCapitalGrantLifecycle,
    Effect.die(new Error('build continuation must not run pre-activation reconciliation')),
    config.operationTimeoutMs,
  )

const recoverBuildContinuation = (continuation = researchBuildContinuation) =>
  recoverCapitalActivationGeneration(
    continuationApplicationPlan,
    continuationRequest,
    continuation,
    null,
    continuationAuthorityStore(),
    unusedAuthorityRestrictionStore,
    unusedWriterFence,
  )

describe('Bayn application platform', () => {
  test('provides filesystem access for TLS-backed PostgreSQL acquisition', async () => {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(ApplicationPlatformLive)))

    expect(Context.get(context, FileSystem.FileSystem)).toBeDefined()
  })

  test('builds qualified activation from the runtime PostgreSQL client and already-held writer fence', async () => {
    const sql = (() =>
      Effect.die(new Error('qualified activation store build must not execute SQL'))) as unknown as PgClient.PgClient
    const writerFence: WriterFenceService = {
      backendPid: 42,
      check: Effect.void,
      transaction: (effect) => effect,
    }

    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(QualifiedCapitalActivationStoreLive(continuationApplicationPlan.config, sql, writerFence)),
      ),
    )

    expect(Context.get(context, CapitalGrantLifecycleStore)).toBeDefined()
  })

  test('activates and verifies durable qualified capital authority before runtime realization', async () => {
    const generationHash = hash('1')
    const proof = {
      schemaVersion: 'bayn.paper-authority-proof-binding.v1' as const,
      riskPolicyHash: hash('2'),
      proofPlanHash: hash('3'),
    }
    let activationCalls = 0
    const sourceGenerationHash = hash('source-generation')
    const lifecycle: Pick<CapitalGrantLifecycleStoreShape, 'activatePreparedCapitalGrant'> = {
      activatePreparedCapitalGrant: (observedProof, observedPrepared) =>
        Effect.sync(() => {
          activationCalls += 1
          expect(observedProof).toEqual(proof)
          expect(observedPrepared).toEqual({ generationHash, sourceGenerationHash })
          return {
            schemaVersion: 'bayn.paper-authority.v1' as const,
            generationHash,
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
            version: 2,
            updatedAt: '2026-08-12T16:00:00.000Z',
          }
        }),
    }

    const activated = await Effect.runPromise(
      activatePreparedQualifiedCapitalGeneration(lifecycle, proof, { generationHash, sourceGenerationHash }),
    )
    expect(activationCalls).toBe(1)
    expect(activated).toMatchObject({
      generationHash,
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
    })

    const mismatch = await Effect.runPromise(
      Effect.flip(
        activatePreparedQualifiedCapitalGeneration(
          {
            activatePreparedCapitalGrant: () => Effect.succeed({ ...activated, generationHash: hash('4') }),
          },
          proof,
          { generationHash, sourceGenerationHash },
        ),
      ),
    )
    expect(mismatch.message).toBe('qualified capital authority does not match the prepared generation')
  })

  test('owns the Restate reconciliation guardian for exactly the service scope', async () => {
    let interrupted = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          yield* runRestateLifecycleWithReconciliationGuardian(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
            ),
            30_000,
            Effect.never,
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(started)
        }),
      ),
    )

    expect(interrupted).toBe(true)
  })

  test('propagates a reconciliation guardian defect to the owning Restate lifecycle', async () => {
    const defect = new Error('guardian invariant defect')

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycleStarted = yield* Deferred.make<void>()
        const lifecycleInterrupted = yield* Deferred.make<void>()
        const result = yield* runRestateLifecycleWithReconciliationGuardian(
          Deferred.await(lifecycleStarted).pipe(Effect.andThen(Effect.die(defect))),
          30_000,
          Deferred.succeed(lifecycleStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(lifecycleInterrupted, undefined)),
          ),
        ).pipe(Effect.exit)
        yield* Deferred.await(lifecycleInterrupted)
        return result
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain(defect.message)
    }
  })
})

describe('Bayn PAPER receipt retry boundary', () => {
  test('restricts expired authority before reconciliation and blocks finalization when reconciliation fails', async () => {
    const events: string[] = []
    const success = await Effect.runPromise(
      runLifecycleMaintenanceAdvance(
        Effect.sync(() => {
          events.push('reconcile')
        }),
        {
          beforeReconciliation: Effect.sync(() => {
            events.push('restrict')
          }),
          afterReconciliation: Effect.sync(() => {
            events.push('finalize')
            return 'CONTINUE' as const
          }),
        },
      ),
    )

    expect(success).toBe('CONTINUE')
    expect(events).toEqual(['restrict', 'reconcile', 'finalize'])

    let finalizationRuns = 0
    const reconciliationFailure = new ReconciliationError({
      operation: 'snapshot',
      message: 'receipt reconciliation failed',
    })
    const failure = await Effect.runPromise(
      Effect.flip(
        runLifecycleMaintenanceAdvance(Effect.fail(reconciliationFailure), {
          beforeReconciliation: Effect.sync(() => {
            events.push('restrict-after-expiry')
          }),
          afterReconciliation: Effect.sync(() => {
            finalizationRuns += 1
            return 'CONTINUE' as const
          }),
        }),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'reconcile-not-due',
      message: 'same-pass reconciliation failed: receipt reconciliation failed',
    })
    expect(finalizationRuns).toBe(0)
    expect(events).toContain('restrict-after-expiry')
  })

  test('does not bind a generation receipt before its PAPER entry cutoff', () => {
    const cutoffAt = '2026-08-03T12:00:00.000Z'

    expect(closedCycleReceiptEmissionAllowed(cutoffAt, '2026-08-03T11:59:59.999Z')).toBe(false)
    expect(closedCycleReceiptEmissionAllowed(cutoffAt, cutoffAt)).toBe(true)
  })

  test('derives due expiry and receipt work from immutable episode deadlines', () => {
    const cutoffAt = '2026-08-03T12:00:00.000Z'
    const closeExpiresAt = '2026-08-03T12:15:00.000Z'
    const finalizationExpiresAt = '2026-08-03T12:30:00.000Z'

    expect(
      decideExecutionLifecycleMaintenance({
        cutoffAt,
        closeExpiresAt,
        finalizationExpiresAt,
        observedAt: '2026-08-03T11:59:59.999Z',
      }),
    ).toEqual({ restrictExpiredAuthority: false, attemptReceiptFinalization: false })
    expect(
      decideExecutionLifecycleMaintenance({
        cutoffAt,
        closeExpiresAt,
        finalizationExpiresAt,
        observedAt: cutoffAt,
      }),
    ).toEqual({ restrictExpiredAuthority: false, attemptReceiptFinalization: true })
    expect(
      decideExecutionLifecycleMaintenance({
        cutoffAt,
        closeExpiresAt,
        finalizationExpiresAt,
        observedAt: closeExpiresAt,
      }),
    ).toEqual({ restrictExpiredAuthority: true, attemptReceiptFinalization: true })
    expect(
      decideExecutionLifecycleMaintenance({
        cutoffAt,
        closeExpiresAt,
        finalizationExpiresAt,
        observedAt: '2026-08-03T12:30:00.001Z',
      }),
    ).toEqual({ restrictExpiredAuthority: true, attemptReceiptFinalization: false })
  })

  test('executes due expiry and receipt work in one writer-fenced lifecycle command', async () => {
    const operations: string[] = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: () =>
        Effect.sync(() => {
          operations.push('restrict')
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          operations.push('fence')
        }).pipe(Effect.andThen(effect)),
    }

    const disposition = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-03T20:15:00.000Z'))
        return yield* runLifecycleMaintenanceAdvance(
          Effect.sync(() => {
            operations.push('reconcile')
          }),
          runExecutionLifecycleMaintenance(
            researchRequest,
            authorityRestrictionStore,
            writerFence,
            (cycleId, observedAt) =>
              Effect.sync(() => {
                expect(cycleId).toBeUndefined()
                expect(observedAt).toBe('2026-09-03T20:15:00.000Z')
                operations.push('finalize')
                return true
              }),
          ),
        )
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(operations).toEqual(['fence', 'restrict', 'reconcile', 'fence', 'restrict', 'finalize'])
    expect(disposition).toBe('COMPLETED')
  })

  test('restricts authority when reconciliation crosses the close expiry boundary', async () => {
    const operations: string[] = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: () =>
        Effect.sync(() => {
          operations.push('restrict')
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          operations.push('fence')
        }).pipe(Effect.andThen(effect)),
    }

    const disposition = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-03T20:14:59.999Z'))
        return yield* runLifecycleMaintenanceAdvance(
          Effect.sync(() => {
            operations.push('reconcile')
          }).pipe(Effect.andThen(TestClock.adjust(1))),
          runExecutionLifecycleMaintenance(
            researchRequest,
            authorityRestrictionStore,
            writerFence,
            (_cycleId, observedAt) =>
              Effect.sync(() => {
                expect(observedAt).toBe('2026-09-03T20:15:00.000Z')
                operations.push('finalize')
                return false
              }),
          ),
        )
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(operations).toEqual(['reconcile', 'fence', 'restrict', 'finalize'])
    expect(disposition).toBe('CONTINUE')
  })

  test('leaves a bounded post-close finalization window for late settlement', () => {
    expect(executionEpisodeReceiptFinalizationExpiresAt('2026-08-03T12:00:00.000Z')).toBe('2026-08-03T12:30:00.000Z')
  })

  test('keeps receipt finalization available after a restart during the close-to-receipt grace window', () => {
    expect(capitalReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:15:00.001Z')).toBe(true)
    expect(capitalReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:30:00.000Z')).toBe(false)
    expect(capitalReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:14:59.999Z')).toBe(false)
  })
})

describe('Bayn capital startup recovery boundary', () => {
  test('does not require qualification evidence for plain OBSERVE or research execution', () => {
    expect(capitalActivationRequiresQualificationEvidence(null)).toBe(false)
    expect(capitalActivationRequiresQualificationEvidence(researchRequest)).toBe(false)
  })

  test('recovers a configured pinned qualification without requiring a capital activation request', async () => {
    const state = await Effect.runPromise(
      Ref.make(
        initialState({
          broker: {
            expectedAccountId: continuationAccountId,
            executionEligible: false,
            executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
          },
        }),
      ),
    )

    await Effect.runPromise(
      refreshReadOnlyQualification(pinnedStatusApplicationPlan, Result.succeed(null), state, {
        marketData: marketDataService(Effect.die(new Error('pinned recovery must not load market data'))),
        journal: successfulJournal,
        evidenceStore: pinnedStore(),
      }),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      evidence: { evaluation: { runId: pinnedEvaluation.runId } },
    })
  })

  test('retries transient pinned qualification recovery and stops reading after success', async () => {
    const state = await Effect.runPromise(Ref.make(initialState({})))
    const store = pinnedStore()
    let readAttempts = 0
    const evidenceStore = {
      ...store,
      read: (runId: string) =>
        Effect.suspend(() => {
          readAttempts += 1
          return readAttempts === 1
            ? Effect.fail(
                new DatabaseError({
                  failure: 'unavailable',
                  operation: 'read-pinned-qualification',
                  message: 'transient test outage',
                  cause: { _tag: 'TransientTestOutage' },
                }),
              )
            : store.read(runId)
        }),
    }
    const refresh = refreshReadOnlyQualification(pinnedStatusApplicationPlan, Result.succeed(null), state, {
      marketData: marketDataService(Effect.die(new Error('pinned recovery must not load market data'))),
      journal: successfulJournal,
      evidenceStore,
    })

    await Effect.runPromise(refresh)
    expect((await Effect.runPromise(Ref.get(state))).evidence).toBeNull()
    await Effect.runPromise(refresh)
    await Effect.runPromise(refresh)

    expect((await Effect.runPromise(Ref.get(state))).evidence?.evaluation.runId).toBe(pinnedEvaluation.runId)
    expect(readAttempts).toBe(2)
  })

  test('keeps cycle observations keyed by the immutable grant after execution completes', () => {
    const configured = Result.succeed({
      request: continuationRequest,
      buildContinuation: researchBuildContinuation,
    })

    expect(readOnlyCycleObservationId(configured, pinnedEvaluation.runId)).toBe(continuationRequest.grant.planHash)
    expect(readOnlyCycleObservationId(Result.succeed(null), pinnedEvaluation.runId)).toBe(pinnedEvaluation.runId)
    expect(readOnlyCycleObservationId(Result.succeed(null), undefined)).toBeUndefined()
  })

  test('binds request-free status to the current durable OBSERVE generation after rotation', async () => {
    const currentGenerationHash = hash('current-durable-observe-generation')
    const cycleObservationId = await Effect.runPromise(
      resolveReadOnlyCycleObservationId(Result.succeed(null), undefined, {
        ensureAuthorityGeneration: () =>
          Effect.die(new Error('request-free read-only status must not mutate authority')),
        readAuthorityState: Effect.succeed({
          schemaVersion: 'bayn.paper-authority.v1',
          generationHash: currentGenerationHash,
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Clear,
          version: 2,
          updatedAt: '2026-08-15T07:00:00.000Z',
        }),
      }),
    )

    expect(cycleObservationId).toBe(currentGenerationHash)
  })

  test('interrupts a stalled durable authority read before a later health pass can retain stale READY', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const resolution = resolveReadOnlyCycleObservationIdForHealth(
          Result.succeed(null),
          undefined,
          {
            ensureAuthorityGeneration: () =>
              Effect.die(new Error('request-free read-only status must not mutate authority')),
            readAuthorityState: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
          },
          10,
        )
        const fiber = yield* resolution.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* TestClock.adjust(10)
        const resolved = yield* Fiber.join(fiber)
        yield* Deferred.await(interrupted)
        return resolved
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(result).toBeUndefined()
  })

  test('requires qualification evidence only for valid qualification-bound status configuration', () => {
    expect(readOnlyQualificationEvidenceRequired(Result.succeed(null), BrokerAccess.ReadOnly)).toBe(false)
    expect(readOnlyQualificationEvidenceRequired(Result.succeed(null), BrokerAccess.Mutation)).toBe(true)
    expect(
      readOnlyQualificationEvidenceRequired(
        Result.succeed({ request: researchRequest, buildContinuation: researchBuildContinuation }),
        BrokerAccess.Mutation,
      ),
    ).toBe(false)
    expect(readOnlyQualificationEvidenceRequired(Result.fail('invalid activation'), BrokerAccess.ReadOnly)).toBe(true)
  })

  test('binds read-only health to the configured worker plan rather than the status pod plan', () => {
    const expectedWorkerPlanHash = hash('7')
    const statusPlan = {
      ...continuationApplicationPlan,
      config: {
        ...continuationApplicationPlan.config,
        expectedExecutionControllerPlanHash: expectedWorkerPlanHash,
      },
    }
    const localPlan = Result.getOrThrow(executionControllerConfig(statusPlan))

    expect(localPlan.planHash).not.toBe(expectedWorkerPlanHash)
    expect(readOnlyExecutionControllerBinding(statusPlan)).toEqual({
      controllerKey: continuationBrokerIdentity.identityHash,
      planHash: expectedWorkerPlanHash,
    })
    expect(readOnlyExecutionControllerBinding(continuationApplicationPlan)).toBeUndefined()
  })

  test('projects an exact active generation without calling any authority mutation', async () => {
    const state = await Effect.runPromise(
      Ref.make(
        initialState({
          broker: {
            expectedAccountId: continuationAccountId,
            executionEligible: false,
            executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
          },
          autonomousCycleLoopConfigured: true,
          autonomousCycleLoopOwner: 'Restate',
          executionController: {
            controllerKey: continuationBrokerIdentity.identityHash,
            planHash: 'f'.repeat(64),
          },
        }),
      ),
    )

    await Effect.runPromise(
      refreshReadOnlyCapitalActivation(
        continuationApplicationPlan,
        Result.succeed({ request: continuationRequest, buildContinuation: researchBuildContinuation }),
        state,
        {
          authority: continuationAuthorityStore(),
          readReceiptHash: () => Effect.die(new Error('active generation must not read a completed receipt')),
        },
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      capitalActivation: {
        _tag: 'Realized',
        requestHash: continuationRequest.requestHash,
        generationHash: continuationGeneration.generationHash,
        grant: 'Research',
      },
      broker: { executionEligible: true, executionDisabledReason: null },
    })
  })

  test('fails closed on invalid activation configuration before durable reads', async () => {
    const state = await Effect.runPromise(
      Ref.make(
        initialState({
          broker: {
            expectedAccountId: continuationAccountId,
            executionEligible: false,
            executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
          },
          autonomousCycleLoopConfigured: true,
          autonomousCycleLoopOwner: 'Restate',
          executionController: {
            controllerKey: continuationBrokerIdentity.identityHash,
            planHash: 'f'.repeat(64),
          },
        }),
      ),
    )
    const unreachable = Effect.die(new Error('invalid activation must not access durable authority'))

    await Effect.runPromise(
      refreshReadOnlyCapitalActivation(continuationApplicationPlan, Result.fail('invalid'), state, {
        authority: {
          ensureAuthorityGeneration: () => unreachable,
          readAuthorityState: unreachable,
        },
        readReceiptHash: () => unreachable,
      }),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      capitalActivation: { _tag: 'Pending', requestHash: null, reason: 'REQUEST_INVALID' },
      broker: {
        executionEligible: false,
        executionDisabledReason: 'CAPITAL_ACTIVATION_NOT_PREPARED',
      },
    })
  })

  test('times out a stalled durable capital projection before the next health pass', async () => {
    const state = await Effect.runPromise(
      Ref.make(
        initialState({
          broker: {
            expectedAccountId: continuationAccountId,
            executionEligible: true,
            executionDisabledReason: null,
          },
        }),
      ),
    )
    const started = await Effect.runPromise(Deferred.make<void>())
    const timedPlan = {
      ...continuationApplicationPlan,
      config: { ...continuationApplicationPlan.config, operationTimeoutMs: 10 },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const refresh = refreshReadOnlyCapitalActivation(
          timedPlan,
          Result.succeed({ request: continuationRequest, buildContinuation: researchBuildContinuation }),
          state,
          {
            authority: {
              ensureAuthorityGeneration: () => Effect.die(new Error('read-only status must not mutate authority')),
              readAuthorityState: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            },
            readReceiptHash: () => Effect.die(new Error('stalled authority read must not inspect a receipt')),
          },
        )
        const fiber = yield* refresh.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* TestClock.adjust(10)
        yield* Fiber.join(fiber)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      capitalActivation: {
        _tag: 'Pending',
        requestHash: continuationRequest.requestHash,
        reason: 'PREPARATION_FAILED',
      },
      broker: {
        executionEligible: false,
        executionDisabledReason: 'CAPITAL_ACTIVATION_NOT_PREPARED',
      },
    })
  })

  test('starts OBSERVE cycles from the persisted successor and never from stale PAPER authority', () => {
    const successorGenerationHash = Result.getOrThrow(
      executionObserveSuccessorGenerationHash({ previousExecutionGenerationHash: hash('12') }),
    )
    const observeAuthority: AuthorityState = {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: successorGenerationHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      version: 3,
      updatedAt: '2026-08-11T13:00:00.000Z',
    }

    expect(observeCycleGenerationHash(observeAuthority)).toEqual(Result.succeed(successorGenerationHash))
    expect(
      observeCycleGenerationHash({
        ...observeAuthority,
        generationHash: hash('34'),
        maximum: Authority.Execution,
        effective: Authority.Execution,
      }),
    ).toEqual(Result.fail('OBSERVE cycle startup requires current effective OBSERVE authority'))
  })

  test('recovers a committed qualified generation before rerunning candidate discovery', async () => {
    const baseEvidence = readyState().evidence
    if (baseEvidence === null) throw new Error('qualified activation recovery requires runtime evidence')
    const qualifiedEvidence: RuntimeEvidence = {
      ...baseEvidence,
      qualification: {
        ...baseEvidence.qualification,
        verdict: 'QUALIFIED',
        evaluationVerdict: {
          ...baseEvidence.qualification.evaluationVerdict,
          status: 'PASS',
          gates: baseEvidence.qualification.evaluationVerdict.gates.map((gate) => ({ ...gate, passed: true })),
        },
        analysis: {
          ...baseEvidence.qualification.analysis,
          status: 'PASS',
          reasonCodes: [],
        },
        reasonCodes: [],
      },
    }
    const request = Result.getOrThrow(
      makeCapitalActivationRequest({
        schemaVersion: 'bayn.paper-activation-request.v1',
        qualification: {
          runId: qualifiedEvidence.qualification.runId,
          lockId: qualifiedEvidence.qualification.lockId,
          resultHash: qualifiedEvidence.qualification.resultHash,
          sourceRevision: qualifiedEvidence.provenance.sourceRevision,
          imageRepository: qualifiedEvidence.provenance.image.repository,
          imageDigest: qualifiedEvidence.provenance.image.digest,
        },
        activation: continuationApplicationPlan.config.build,
        strategy: {
          name: continuationApplicationPlan.strategy.provenance.strategy.name,
          behaviorHash: continuationApplicationPlan.strategy.provenance.strategy.behaviorHash,
          parameterHash: continuationApplicationPlan.strategy.provenance.strategy.parameterHash,
          parameterSchemaVersion: continuationApplicationPlan.strategy.provenance.strategy.parameterSchemaVersion,
          protocolHash: continuationApplicationPlan.strategyProtocolHash,
        },
        limits: { maxOpenOrders: 0, maxPositions: 0 },
        cutoffAt: '2026-09-01T13:30:00.000Z',
        expiresAt: '2026-09-01T20:00:00.000Z',
      }),
    )
    const generation = Result.getOrThrow(
      makeCapitalGrantGenerationResult({
        schemaVersion: 'bayn.paper-authority-generation.v2',
        maximum: Authority.Execution,
        previousGenerationHash: continuationApplicationPlan.config.alpaca.authorityGenerationHash,
        qualificationRunId: request.qualification.runId,
        qualificationLockId: request.qualification.lockId,
        qualificationResultHash: request.qualification.resultHash,
        protocolHash: request.strategy.protocolHash,
        qualificationExecutionPolicyHash: hash('1'),
        qualificationSourceRevision: request.qualification.sourceRevision,
        qualificationImageRepository: request.qualification.imageRepository,
        qualificationImageDigest: request.qualification.imageDigest,
        activationSourceRevision: request.activation.sourceRevision,
        activationImageRepository: request.activation.imageRepository,
        activationImageDigest: request.activation.imageDigest,
        strategyName: request.strategy.name,
        strategyBehaviorHash: request.strategy.behaviorHash,
        strategyParameterHash: request.strategy.parameterHash,
        strategyParameterSchemaVersion: request.strategy.parameterSchemaVersion,
        accountId: continuationApplicationPlan.config.alpaca.expectedAccountId,
        riskPolicyHash: hash('2'),
        proofPlanHash: hash('3'),
        reconciliationId: hash('4'),
        reconciliationContentHash: hash('5'),
      }),
    )
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: () => Effect.die(new Error('qualified recovery must not rotate authority')),
      readAuthorityState: Effect.succeed({
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: generation.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 2,
        updatedAt: '2026-08-12T19:00:00.000Z',
      }),
      readAuthorityGeneration: (generationHash) =>
        Effect.succeed(generationHash === generation.generationHash ? generation : undefined),
    }
    let preparationStarted = false
    const prepare = Effect.sync(() => {
      preparationStarted = true
    }).pipe(Effect.andThen(Effect.die(new Error('qualified recovery must not rerun candidate discovery'))))

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-08-12T19:30:00.000Z'))
        return yield* prepareOrRecoverQualifiedCapitalActivation(
          continuationApplicationPlan,
          qualifiedEvidence,
          request,
          authorityStore,
          prepare,
        )
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(recovered).toEqual(generation)
    expect(preparationStarted).toBe(false)
  })

  test('recognizes the receipt-completed OBSERVE successor before retrying PAPER recovery on restart', async () => {
    const successorGenerationHash = Result.getOrThrow(
      executionObserveSuccessorGenerationHash({
        previousExecutionGenerationHash: continuationGeneration.generationHash,
      }),
    )
    const receiptHash = hash('receipt')
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: () => Effect.die(new Error('completed execution must not mutate authority')),
      readAuthorityState: Effect.succeed({
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: successorGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 3,
        updatedAt: '2026-09-03T20:01:00.000Z',
      }),
      readAuthorityGenerationLineage: (generationHash) =>
        Effect.succeed(
          generationHash === successorGenerationHash
            ? {
                generationHash,
                previousGenerationHash: continuationGeneration.generationHash,
                maximum: Authority.Observe,
              }
            : undefined,
        ),
      readResearchAuthorityGeneration: (generationHash) =>
        Effect.succeed(generationHash === continuationGeneration.generationHash ? continuationGeneration : undefined),
    }
    const readReceiptHash = (generationHash: string) =>
      Effect.succeed(
        generationHash === continuationGeneration.generationHash ? Option.some(receiptHash) : Option.none<string>(),
      )

    const completed = await Effect.runPromise(
      readCompletedExecutionLifecycle(
        continuationApplicationPlan,
        continuationRequest,
        researchBuildContinuation,
        authorityStore,
        readReceiptHash,
      ),
    )
    const withoutReceipt = await Effect.runPromise(
      readCompletedExecutionLifecycle(
        continuationApplicationPlan,
        continuationRequest,
        researchBuildContinuation,
        authorityStore,
        () => Effect.succeed(Option.none()),
      ),
    )

    expect(completed).toEqual({
      authorityGenerationHash: continuationGeneration.generationHash,
      receiptHash,
    })
    expect(withoutReceipt).toBeUndefined()
  })

  test('resumes only the exact active research generation across a reviewed build change', async () => {
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const logger = Logger.make<unknown, void>((entry) => {
      logs.push({
        message: entry.message,
        annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
      })
    })
    const generation = await Effect.runPromise(resumeBuildContinuation().pipe(Effect.provide(Logger.layer([logger]))))

    expect(generation).toEqual(continuationGeneration)
    expect(logs).toContainEqual({
      message: ['Bayn capital build continuation resumed the active generation'],
      annotations: {
        service: 'bayn',
        activationMode: 'ACTIVE',
        continuationHash: researchBuildContinuation.continuationHash,
        generationHash: continuationGeneration.generationHash,
        sourceRevision: continuationBuild.sourceRevision,
        imageDigest: continuationBuild.imageDigest,
      },
    })
  })

  test('resumes an exact failure-restricted generation for recovery without rearming or activating', async () => {
    const authorityReason = `bound PAPER cycle ${hash('c')} restricted effective authority: intent ${hash('d')} submit settled denied`
    const authority: AuthorityState = {
      ...continuationAuthority,
      effective: Authority.Observe,
      kill: KillState.Active,
      reason: authorityReason,
    }
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const logger = Logger.make<unknown, void>((entry) => {
      logs.push({
        message: entry.message,
        annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
      })
    })

    const generation = await Effect.runPromise(
      resumeBuildContinuation(
        researchBuildContinuation,
        continuationAuthorityStore(continuationGeneration, authority),
      ).pipe(Effect.provide(Logger.layer([logger]))),
    )

    expect(generation).toEqual(continuationGeneration)
    expect(logs).toContainEqual({
      message: ['Bayn capital build continuation resumed a restricted active generation for recovery'],
      annotations: {
        service: 'bayn',
        activationMode: 'RECOVERY_ONLY',
        authorityReason,
        continuationHash: researchBuildContinuation.continuationHash,
        generationHash: continuationGeneration.generationHash,
        sourceRevision: continuationBuild.sourceRevision,
        imageDigest: continuationBuild.imageDigest,
      },
    })
  })

  test('fails closed before rearm or activation when continuation generation history is absent or mismatched', async () => {
    const cases = [
      {
        continuation: researchBuildContinuation,
        store: continuationAuthorityStore(null),
        message: 'durable research capital history is missing',
      },
      {
        continuation: mismatchedResearchBuildContinuation,
        store: continuationAuthorityStore(),
        message: 'research capital build continuation requires the exact active generation',
      },
    ] as const

    for (const fixture of cases) {
      const failure = await Effect.runPromise(Effect.flip(resumeBuildContinuation(fixture.continuation, fixture.store)))

      expect(failure.message).toBe(fixture.message)
    }
  })

  test('reconciles a completed capital generation before rearming and activates from its OBSERVE successor', async () => {
    const previousExecutionGenerationHash = continuationGeneration.generationHash
    const successorGenerationHash = Result.getOrThrow(
      executionObserveSuccessorGenerationHash({ previousExecutionGenerationHash }),
    )
    const riskPolicy = await Effect.runPromise(
      loadObserveRiskPolicy(continuationAccountId, continuationApplicationPlan.strategy.definition.parameters.universe),
    )
    const riskPolicyHash = Result.getOrThrow(canonicalHashV1Result(riskPolicy))
    const plan = { ...continuationResearchPlan, activation: continuationBuild, riskPolicyHash }
    const { schemaVersion: _schemaVersion, ...planFields } = plan
    const request = Result.getOrThrow(
      makeResearchCapitalActivationRequest({
        schemaVersion: 'bayn.paper-research-activation-request.v1',
        grant: { _tag: 'Research', planHash: Result.getOrThrow(makeResearchCapitalPlanHash(plan)) },
        ...planFields,
      }),
    )
    const generation = Result.getOrThrow(
      makeResearchCapitalGrantGenerationResult({
        schemaVersion: 'bayn.paper-authority-generation.v3',
        maximum: Authority.Execution,
        previousGenerationHash: successorGenerationHash,
        grant: request.grant,
        activationSourceRevision: request.activation.sourceRevision,
        activationImageRepository: request.activation.imageRepository,
        activationImageDigest: request.activation.imageDigest,
        strategyName: request.strategy.name,
        strategyBehaviorHash: request.strategy.behaviorHash,
        strategyParameterHash: request.strategy.parameterHash,
        strategyParameterSchemaVersion: request.strategy.parameterSchemaVersion,
        strategyProtocolHash: request.strategy.protocolHash,
        accountId: request.broker.accountId,
        brokerIdentityHash: request.broker.identityHash,
        riskPolicyHash: request.riskPolicyHash,
        proofPlanHash: request.grant.planHash,
        reconciliationId: hash('34'),
        reconciliationContentHash: hash('56'),
      }),
    )
    let authority: AuthorityState = {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: previousExecutionGenerationHash,
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      version: 2,
      updatedAt: '2026-08-31T19:59:59.000Z',
    }
    const operations: string[] = []
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: ({ generationHash, maximum }) =>
        Effect.sync(() => {
          operations.push(`rearm:${generationHash}`)
          expect({ generationHash, maximum }).toEqual({
            generationHash: successorGenerationHash,
            maximum: Authority.Observe,
          })
          authority = {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash: successorGenerationHash,
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: KillState.Clear,
            version: 3,
            updatedAt: '2026-08-31T20:00:00.500Z',
          }
          return authority
        }),
      readAuthorityState: Effect.sync(() => authority),
      readResearchAuthorityGeneration: (generationHash) =>
        Effect.succeed(
          generationHash === continuationGeneration.generationHash
            ? continuationGeneration
            : generationHash === generation.generationHash
              ? generation
              : undefined,
        ),
    }
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () => Effect.die(new Error('research activation must not prepare qualified authority')),
      activateCapitalGrant: () => Effect.die(new Error('research activation must not activate qualified authority')),
      activatePreparedCapitalGrant: () =>
        Effect.die(new Error('research activation must not activate prepared qualified authority')),
      activateResearchCapitalGrant: (_proof, sourceGenerationHash) =>
        Effect.sync(() => {
          operations.push(`activate:${sourceGenerationHash}`)
          authority = {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash: generation.generationHash,
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
            version: 4,
            updatedAt: '2026-08-31T20:00:01.000Z',
          }
          return authority
        }),
    }
    const unusedBrokerRead = Effect.die(new Error('research activation performed an unrelated broker read'))
    const session: BrokerSessionShape = {
      connection: {
        provider: continuationApplicationPlan.config.alpaca.provider,
        environment: continuationApplicationPlan.config.alpaca.environment,
        identity: continuationApplicationPlan.config.alpaca.identity,
        baseUrl: continuationApplicationPlan.config.alpaca.baseUrl,
        expectedAccountId: continuationApplicationPlan.config.alpaca.expectedAccountId,
        key: continuationApplicationPlan.config.alpaca.key,
        secret: continuationApplicationPlan.config.alpaca.secret,
        proxyUrl: continuationApplicationPlan.config.alpaca.proxyUrl,
        operationTimeoutMs: continuationApplicationPlan.config.alpaca.operationTimeoutMs,
        retryAttempts: continuationApplicationPlan.config.alpaca.retryAttempts,
      },
      preflight: {
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        baseUrl: alpacaSandboxBaseUrl,
        accountId: continuationAccountId,
        accountStatus: AccountStatus.Active,
        accountBlocked: false,
        tradingBlocked: false,
        tradeSuspendedByUser: false,
        accountHash: hash('78'),
        fractionalTrading: true,
        accountConfigurationHash: hash('9a'),
        openOrderCount: 0,
        recentOrderCount: 0,
        ordersHash: hash('bc'),
        positionCount: 0,
        positionsHash: hash('de'),
        fillCount: 0,
        fillsHash: hash('f0'),
        marketCalendarSessionCount: 3,
        marketCalendarHash: hash('12'),
        orderById: 'NOT_FOUND',
        orderByClientId: 'NOT_FOUND',
      },
      read: {
        account: unusedBrokerRead,
        accountConfiguration: unusedBrokerRead,
        assetBySymbol: () => unusedBrokerRead,
        positions: unusedBrokerRead,
        orders: () => unusedBrokerRead,
        orderById: () => unusedBrokerRead,
        orderByClientId: () => unusedBrokerRead,
        fillActivities: () => unusedBrokerRead,
        marketCalendar: (query: { readonly start: string; readonly end: string }) =>
          Effect.succeed({
            value: {
              schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
              source: 'alpaca-v2-calendar',
              requestedRange: query,
              timeZone: 'UTC',
              sessions: [
                { date: '2026-09-01', openAt: '2026-09-01T13:30:00.000Z', closeAt: '2026-09-01T20:00:00.000Z' },
                { date: '2026-09-02', openAt: '2026-09-02T13:30:00.000Z', closeAt: '2026-09-02T20:00:00.000Z' },
                { date: '2026-09-03', openAt: '2026-09-03T13:30:00.000Z', closeAt: '2026-09-03T20:00:00.000Z' },
              ],
              normalizedResponseHash: hash('34'),
            },
            evidence: {
              requestId: 'calendar-request',
              status: 200,
              contentHash: hash('56'),
              observedAt: '2026-08-31T20:00:00.000Z',
            },
          }),
      },
    }

    const activated = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-08-31T20:00:00.000Z'))
        return yield* prepareOrRecoverResearchCapitalActivation(
          continuationApplicationPlan,
          request,
          null,
          session,
          authorityStore,
          lifecycle,
          Effect.sync(() => operations.push('reconcile')),
          config.operationTimeoutMs,
        )
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(activated).toEqual(generation)
    expect(operations).toEqual(['reconcile', `rearm:${successorGenerationHash}`, `activate:${successorGenerationHash}`])
  })

  test('recovers the exact continuation after cutoff and rejects stale build or generation bindings', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-02T13:30:00.000Z'))
        const recovered = yield* recoverBuildContinuation()
        const mismatched = yield* recoverBuildContinuation(mismatchedResearchBuildContinuation).pipe(Effect.flip)
        const stale = yield* recoverBuildContinuation(staleResearchBuildContinuation).pipe(Effect.flip)
        return { recovered, mismatched, stale }
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(result.recovered).toEqual(continuationGeneration)
    expect(result.mismatched.message).toBe(
      'research capital build continuation is not bound to the active generation and current build',
    )
    expect(result.stale.message).toBe('capital activation request is not bound to the current activation build')
  })

  test('persists one fresh reconciliation before activating a new research capital generation', async () => {
    const operations: string[] = []

    await Effect.runPromise(
      refreshResearchCapitalActivationReconciliation(
        Effect.sync(() => {
          operations.push('reconcile')
        }),
        1_000,
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            operations.push('activate')
          }),
        ),
      ),
    )

    expect(operations).toEqual(['reconcile', 'activate'])
  })

  test('settles, freshly reconciles, and only then rolls a blocked generation to clear OBSERVE', async () => {
    const operations: string[] = []
    const previousGenerationHash = hash('2')
    const successorGenerationHash = Result.getOrThrow(
      executionObserveSuccessorGenerationHash({
        previousExecutionGenerationHash: previousGenerationHash,
      }),
    )
    const blockedIntents: BlockedCycleIntentStoreShape = {
      terminalizeUntouchedApproved: () => Effect.die(new Error('cycle terminalization is outside startup recovery')),
      settleCurrentTerminalGeneration: () =>
        Effect.sync(() => {
          operations.push('settle')
          return {
            _tag: 'TerminalGenerationSettled' as const,
            authorityGenerationHash: previousGenerationHash,
            blockedCycleCount: 1,
            blockedIntentCount: 0,
            expiredIntentCount: 1,
            intentCount: 1,
            terminalIntentCount: 1,
          }
        }),
    }
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: (input) =>
        Effect.sync(() => {
          operations.push('rollover')
          return {
            schemaVersion: 'bayn.paper-authority.v1' as const,
            generationHash: input.generationHash,
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: KillState.Clear,
            version: 3,
            updatedAt: '2026-08-10T19:00:02.000Z',
          }
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: (effect) => Effect.sync(() => operations.push('fence')).pipe(Effect.andThen(effect)),
    }

    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-08-10T19:00:00.000Z'))
        return yield* recoverTerminalGenerationToObserve({
          accountId: 'paper-account',
          blockedIntents,
          authorityStore,
          writerFence,
          reconcileAfterSettlement: Effect.sync(() => operations.push('reconcile')),
        })
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(operations).toEqual(['fence', 'settle', 'reconcile', 'rollover'])
    expect(receipt).toEqual({
      _tag: 'RolledOver',
      previousGenerationHash,
      generationHash: successorGenerationHash,
      blockedCycleCount: 1,
      blockedIntentCount: 0,
      expiredIntentCount: 1,
      terminalIntentCount: 1,
    })
  })

  test('derives one stable OBSERVE successor per immutable capital generation', () => {
    const previousExecutionGenerationHash = hash('2')
    const first = Result.getOrThrow(executionObserveSuccessorGenerationHash({ previousExecutionGenerationHash }))
    const replay = Result.getOrThrow(executionObserveSuccessorGenerationHash({ previousExecutionGenerationHash }))
    const nextEpisode = Result.getOrThrow(
      executionObserveSuccessorGenerationHash({
        previousExecutionGenerationHash: hash('3'),
      }),
    )

    expect(first).toBe(replay)
    expect(first).toBe('4a7bc5e5312820740ccdce4d25358985badba54e94af3a2037f5cf87f4a106c7')
    expect(first).not.toBe(previousExecutionGenerationHash)
    expect(nextEpisode).not.toBe(first)
  })

  test('does not reconcile or rotate when no terminal generation exists', async () => {
    const blockedIntents: BlockedCycleIntentStoreShape = {
      terminalizeUntouchedApproved: () => Effect.die(new Error('cycle terminalization is outside startup recovery')),
      settleCurrentTerminalGeneration: () => Effect.succeed({ _tag: 'NoTerminalGeneration' }),
    }
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: () => Effect.die(new Error('no terminal generation must not rotate authority')),
    }

    const receipt = await Effect.runPromise(
      recoverTerminalGenerationToObserve({
        accountId: 'paper-account',
        blockedIntents,
        authorityStore,
        writerFence: unusedWriterFence,
        reconcileAfterSettlement: Effect.die(new Error('no terminal generation must not reconcile')),
      }),
    )

    expect(receipt).toEqual({ _tag: 'NotRequired' })
  })

  test('recovers a nonterminal mutation before retrying blocked-generation settlement', async () => {
    const operations: string[] = []
    let attempt = 0
    const receipt = await Effect.runPromise(
      recoverRestrictedGenerationBeforeRollover({
        advance: Effect.sync(() => {
          attempt += 1
          operations.push(`recover:${attempt.toString()}`)
          return attempt
        }),
        wait: (advanced) => Effect.sync(() => operations.push(`wait:${advanced.toString()}`)),
        settle: Effect.suspend(() => {
          operations.push(`settle:${attempt.toString()}`)
          return attempt === 1
            ? Effect.fail(
                new OperationalError({
                  component: 'strategy',
                  operation: 'terminal-generation-recovery',
                  message: 'blocked generation intent settlement failed',
                  retryable: false,
                  cause: new BlockedCycleIntentStoreError({
                    failure: 'invariant',
                    message: 'intent still requires broker recovery',
                  }),
                }),
              )
            : Effect.succeed({
                _tag: 'RolledOver' as const,
                previousGenerationHash: hash('1'),
                generationHash: hash('2'),
                blockedCycleCount: 1,
                blockedIntentCount: 1,
                expiredIntentCount: 0,
                terminalIntentCount: 1,
              })
        }),
      }),
    )

    expect(operations).toEqual(['recover:1', 'settle:1', 'wait:1', 'recover:2', 'settle:2'])
    expect(receipt).toEqual({
      _tag: 'RolledOver',
      previousGenerationHash: hash('1'),
      generationHash: hash('2'),
      blockedCycleCount: 1,
      blockedIntentCount: 1,
      expiredIntentCount: 0,
      terminalIntentCount: 1,
    })
  })

  test('exposes one bounded restricted recovery attempt to an external durable scheduler', async () => {
    let advances = 0
    const waiting = await Effect.runPromise(
      advanceRestrictedGenerationRecovery(
        Effect.sync(() => {
          advances += 1
          return 'recovered-once' as const
        }),
        Effect.fail(
          new OperationalError({
            component: 'strategy',
            operation: 'terminal-generation-recovery',
            message: 'blocked generation intent settlement failed',
            retryable: false,
            cause: new BlockedCycleIntentStoreError({
              failure: 'invariant',
              message: 'intent still requires broker recovery',
            }),
          }),
        ),
      ),
    )

    expect(waiting).toEqual({ _tag: 'Waiting', advance: 'recovered-once' })
    expect(advances).toBe(1)
  })

  test('fails closed when restricted recovery cannot identify a generation to roll over', async () => {
    let advances = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        recoverRestrictedGenerationBeforeRollover({
          advance: Effect.sync(() => {
            advances += 1
          }),
          wait: () => Effect.die(new Error('a missing blocked generation is not retryable')),
          settle: Effect.succeed({ _tag: 'NotRequired' }),
        }),
      ),
    )

    expect(advances).toBe(1)
    expect(failure.message).toBe('restricted generation recovery found no terminal generation to roll over')
  })

  test('keeps activation disabled when the fresh reconciliation fails', async () => {
    const operations: string[] = []
    const reconciliationFailure = new Error('read-only reconciliation failed')

    const failure = await Effect.runPromise(
      Effect.flip(
        refreshResearchCapitalActivationReconciliation(Effect.fail(reconciliationFailure), 1_000).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operations.push('activate')
            }),
          ),
        ),
      ),
    )

    expect(operations).toEqual([])
    expect(failure.message).toBe('research capital pre-activation reconciliation failed')
    expect(failure.cause).toBe(reconciliationFailure)
  })

  test('times out and interrupts pre-activation reconciliation before activation', async () => {
    const operations: string[] = []
    const timeoutFailure = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalizations = yield* Ref.make(0)
        const activation = yield* refreshResearchCapitalActivationReconciliation(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Ref.update(finalizations, (count) => count + 1)),
          ),
          1_000,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operations.push('activate')
            }),
          ),
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        )

        yield* Deferred.await(started)
        yield* TestClock.adjust(999)
        expect(yield* Ref.get(finalizations)).toBe(0)
        yield* TestClock.adjust(1)

        const failure = yield* Fiber.join(activation)
        expect(yield* Ref.get(finalizations)).toBe(1)
        return failure
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(operations).toEqual([])
    expect(timeoutFailure.message).toBe('research capital pre-activation reconciliation failed')
    expect(timeoutFailure.cause).toMatchObject({
      message: 'research capital pre-activation reconciliation timed out',
    })
  })

  test('restricts durable authority before an expired close recovery is rejected', async () => {
    const restrictions: Array<{ readonly reason: string; readonly updatedAt: string }> = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: (reason, updatedAt) =>
        Effect.sync(() => {
          restrictions.push({ reason, updatedAt })
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-08-03T12:00:00.000Z'))
        yield* restrictExpiredCapitalActivation(authorityRestrictionStore, writerFence)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(restrictions).toEqual([
      {
        reason: 'execution activation lease restricted effective authority: immutable activation request expired',
        updatedAt: '2026-08-03T12:00:00.000Z',
      },
    ])
  })

  test('returns to OBSERVE presentation only after the exact flat receipt is durable', async () => {
    const restrictions: string[] = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: (reason) =>
        Effect.sync(() => {
          restrictions.push(reason)
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* Ref.make(
          initialState({
            broker: { expectedAccountId: 'paper-account', executionEligible: true, executionDisabledReason: null },
            autonomousCycleLoopConfigured: true,
          }),
        )
        const finalized = yield* finalizeExecutionEpisode(
          state,
          researchRequest,
          hash('2'),
          authorityRestrictionStore,
          writerFence,
          () => Effect.succeed(hash('a')),
          'cycle-1',
          '2026-09-03T20:01:00.000Z',
        )
        return { finalized, state: yield* Ref.get(state) }
      }),
    )

    expect(result.finalized).toBe(true)
    expect(restrictions).toEqual(['execution episode restricted effective authority: flat exact receipt finalized'])
    expect(result.state.capitalActivation).toEqual({
      _tag: 'Completed',
      requestHash: researchRequest.requestHash,
      generationHash: hash('2'),
      grant: 'Research',
      receiptHash: hash('a'),
    })
    expect(result.state.broker).toMatchObject({
      executionEligible: false,
      executionDisabledReason: 'EXECUTION_EPISODE_COMPLETED',
    })
  })
})
