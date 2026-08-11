import { describe, expect, test } from 'bun:test'

import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Logger, Redacted, Ref, References, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { config, fixtureRuntime } from './app-test-support'
import {
  paperObserveSuccessorGenerationHash,
  recoverBlockedGenerationToObserve,
  recoverRestrictedGenerationBeforeRollover,
} from './blocked-generation-recovery'
import { provideTestLayer } from './effect-test-support'

import {
  ApplicationPlatformLive,
  closedCycleReceiptEmissionAllowed,
  finalizePaperEpisode,
  observeCycleGenerationHash,
  paperReceiptFinalizationWindowOpen,
  prepareOrRecoverResearchPaperActivation,
  recoverPaperActivationGeneration,
  refreshResearchPaperActivationReconciliation,
  restrictExpiredPaperActivation,
  retryClosedCycleReceipts,
} from './composition'
import { makeApplicationPlan, type ApplicationPlanFor } from './app'
import { AccountStatus, alpacaSandboxBaseUrl, type BrokerSessionShape } from './broker/alpaca'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from './broker/identity'
import { makeStrategyProtocolHash } from './contracts'
import type {
  AuthorityGenerationStoreShape,
  AuthorityRestrictionStoreShape,
  CapitalGrantLifecycleStoreShape,
} from './db/execution-store'
import { BrokerAccess, noCapitalAuthority } from './execution/authority'
import {
  makeResearchPaperActivationRequest,
  makeResearchPaperBuildContinuation,
  makeResearchPaperPlanHash,
} from './execution/configuration'
import {
  Authority,
  KillState,
  makeResearchCapitalGrantGenerationResult,
  type AuthorityState,
} from './execution/contracts'
import { BlockedCycleIntentStoreError, type BlockedCycleIntentStoreShape } from './execution/intents'
import type { WriterFenceService } from './execution/writer-fence'
import { OperationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { utcInstantFromEpochMillis } from './time'
import { loadObserveRiskPolicy, paperEpisodeReceiptFinalizationExpiresAt } from './observe-composition'
import { initialState } from './runtime-state'
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
  makeResearchPaperActivationRequest({
    schemaVersion: 'bayn.paper-research-activation-request.v1',
    grant: { _tag: 'Research', planHash: Result.getOrThrow(makeResearchPaperPlanHash(researchPlan)) },
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
  makeResearchPaperActivationRequest({
    schemaVersion: 'bayn.paper-research-activation-request.v1',
    grant: {
      _tag: 'Research',
      planHash: Result.getOrThrow(makeResearchPaperPlanHash(continuationResearchPlan)),
    },
    ...continuationResearchPlanFields,
  }),
)
const continuationGeneration = Result.getOrThrow(
  makeResearchCapitalGrantGenerationResult({
    schemaVersion: 'bayn.paper-authority-generation.v3',
    maximum: Authority.Paper,
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
  makeResearchPaperBuildContinuation({
    schemaVersion: 'bayn.paper-research-build-continuation.v1',
    request: continuationRequest,
    generationHash: continuationGeneration.generationHash,
    activation: continuationBuild,
  }),
)
const mismatchedResearchBuildContinuation = Result.getOrThrow(
  makeResearchPaperBuildContinuation({
    schemaVersion: 'bayn.paper-research-build-continuation.v1',
    request: continuationRequest,
    generationHash: hash('0'),
    activation: continuationBuild,
  }),
)
const staleResearchBuildContinuation = Result.getOrThrow(
  makeResearchPaperBuildContinuation({
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
const continuationAuthority: AuthorityState = {
  schemaVersion: 'bayn.paper-authority.v1',
  generationHash: continuationGeneration.generationHash,
  maximum: Authority.Paper,
  effective: Authority.Paper,
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
  prepareOrRecoverResearchPaperActivation(
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
  recoverPaperActivationGeneration(
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
})

describe('Bayn PAPER receipt retry boundary', () => {
  test('does not bind a generation receipt before its PAPER entry cutoff', () => {
    const cutoffAt = '2026-08-03T12:00:00.000Z'

    expect(closedCycleReceiptEmissionAllowed(cutoffAt, '2026-08-03T11:59:59.999Z')).toBe(false)
    expect(closedCycleReceiptEmissionAllowed(cutoffAt, cutoffAt)).toBe(true)
  })

  test('keeps retrying through the close lease instead of a fixed attempt count', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = utcInstantFromEpochMillis(startAt + 1_000)
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (cycleId, current) =>
            Effect.sync(() => {
              expect(cycleId).toBeUndefined()
              observedAt.push(current)
              return observedAt.length >= 17
            }),
          cutoffAt,
          utcInstantFromEpochMillis(startAt + 17_000),
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(17_000)
        yield* Fiber.join(retry)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(17)
    expect(observedAt.at(-1)).toBe(utcInstantFromEpochMillis(startAt + 17_000))
  })

  test('keeps retrying until close settlement and reconciliation produce a receipt', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = utcInstantFromEpochMillis(startAt + 1_000)
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (_cycleId, current) =>
            Effect.sync(() => {
              observedAt.push(current)
              return observedAt.length >= 8
            }),
          cutoffAt,
          utcInstantFromEpochMillis(startAt + 8_000),
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(8_000)
        yield* Fiber.join(retry)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(8)
    expect(observedAt.at(-1)).toBe(utcInstantFromEpochMillis(startAt + 8_000))
  })

  test('stops receipt retries at the bounded finalization lease when evidence never becomes eligible', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = utcInstantFromEpochMillis(startAt + 1_000)
    const retryUntilAt = utcInstantFromEpochMillis(startAt + 4_000)
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (_cycleId, current) =>
            Effect.sync(() => {
              observedAt.push(current)
              return false
            }),
          cutoffAt,
          retryUntilAt,
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10_000)
        yield* Fiber.join(retry)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(4)
    expect(observedAt.at(-1)).toBe(retryUntilAt)
  })

  test('leaves a bounded post-close finalization window for late settlement', () => {
    expect(paperEpisodeReceiptFinalizationExpiresAt('2026-08-03T12:00:00.000Z')).toBe('2026-08-03T12:30:00.000Z')
  })

  test('keeps receipt finalization available after a restart during the close-to-receipt grace window', () => {
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:15:00.001Z')).toBe(true)
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:30:00.000Z')).toBe(false)
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:14:59.999Z')).toBe(false)
  })
})

describe('Bayn PAPER startup recovery boundary', () => {
  test('starts OBSERVE cycles from the persisted successor and never from stale PAPER authority', () => {
    const successorGenerationHash = Result.getOrThrow(
      paperObserveSuccessorGenerationHash({ previousPaperGenerationHash: hash('12') }),
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
        maximum: Authority.Paper,
        effective: Authority.Paper,
      }),
    ).toEqual(Result.fail('OBSERVE cycle startup requires current effective OBSERVE authority'))
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
      message: ['Bayn PAPER build continuation resumed the active generation'],
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
    const authorityReason =
      'PAPER autonomous cycle loop restricted effective authority: bound cycle blocked: BLOCKED_MISSED_SUBMISSION_DEADLINE'
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
      message: ['Bayn PAPER build continuation resumed a restricted active generation for recovery'],
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
        message: 'durable research PAPER history is missing',
      },
      {
        continuation: mismatchedResearchBuildContinuation,
        store: continuationAuthorityStore(),
        message: 'research PAPER build continuation requires the exact active generation',
      },
    ] as const

    for (const fixture of cases) {
      const failure = await Effect.runPromise(Effect.flip(resumeBuildContinuation(fixture.continuation, fixture.store)))

      expect(failure.message).toBe(fixture.message)
    }
  })

  test('activates research PAPER from the persisted OBSERVE successor instead of the bootstrap hash', async () => {
    const previousPaperGenerationHash = hash('12')
    const successorGenerationHash = Result.getOrThrow(
      paperObserveSuccessorGenerationHash({ previousPaperGenerationHash }),
    )
    const riskPolicy = await Effect.runPromise(
      loadObserveRiskPolicy(continuationAccountId, continuationApplicationPlan.strategy.definition.parameters.universe),
    )
    const riskPolicyHash = Result.getOrThrow(canonicalHashV1Result(riskPolicy))
    const plan = { ...continuationResearchPlan, activation: continuationBuild, riskPolicyHash }
    const { schemaVersion: _schemaVersion, ...planFields } = plan
    const request = Result.getOrThrow(
      makeResearchPaperActivationRequest({
        schemaVersion: 'bayn.paper-research-activation-request.v1',
        grant: { _tag: 'Research', planHash: Result.getOrThrow(makeResearchPaperPlanHash(plan)) },
        ...planFields,
      }),
    )
    const generation = Result.getOrThrow(
      makeResearchCapitalGrantGenerationResult({
        schemaVersion: 'bayn.paper-authority-generation.v3',
        maximum: Authority.Paper,
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
      generationHash: successorGenerationHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      version: 3,
      updatedAt: '2026-08-31T20:00:00.000Z',
    }
    const operations: string[] = []
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: ({ generationHash, maximum }) =>
        Effect.sync(() => {
          operations.push(`validate:${generationHash}`)
          expect({ generationHash, maximum }).toEqual({
            generationHash: successorGenerationHash,
            maximum: Authority.Observe,
          })
          return authority
        }),
      readAuthorityState: Effect.sync(() => authority),
      readResearchAuthorityGeneration: (generationHash) =>
        Effect.succeed(generationHash === generation.generationHash ? generation : undefined),
    }
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () => Effect.die(new Error('research activation must not prepare qualified authority')),
      activateCapitalGrant: () => Effect.die(new Error('research activation must not activate qualified authority')),
      activateResearchCapitalGrant: (_proof, sourceGenerationHash) =>
        Effect.sync(() => {
          operations.push(`activate:${sourceGenerationHash}`)
          authority = {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash: generation.generationHash,
            maximum: Authority.Paper,
            effective: Authority.Paper,
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
        return yield* prepareOrRecoverResearchPaperActivation(
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
    expect(operations).toEqual([
      `validate:${successorGenerationHash}`,
      'reconcile',
      `activate:${successorGenerationHash}`,
    ])
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
      'research PAPER build continuation is not bound to the active generation and current build',
    )
    expect(result.stale.message).toBe('paper activation request is not bound to the current activation build')
  })

  test('persists one fresh reconciliation before activating a new research PAPER generation', async () => {
    const operations: string[] = []

    await Effect.runPromise(
      refreshResearchPaperActivationReconciliation(
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
      paperObserveSuccessorGenerationHash({
        previousPaperGenerationHash: previousGenerationHash,
      }),
    )
    const blockedIntents: BlockedCycleIntentStoreShape = {
      terminalizeUntouchedApproved: () => Effect.die(new Error('cycle terminalization is outside startup recovery')),
      settleCurrentBlockedGeneration: () =>
        Effect.sync(() => {
          operations.push('settle')
          return {
            _tag: 'BlockedGenerationSettled' as const,
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
        return yield* recoverBlockedGenerationToObserve({
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

  test('derives one stable OBSERVE successor per immutable PAPER generation', () => {
    const previousPaperGenerationHash = hash('2')
    const first = Result.getOrThrow(paperObserveSuccessorGenerationHash({ previousPaperGenerationHash }))
    const replay = Result.getOrThrow(paperObserveSuccessorGenerationHash({ previousPaperGenerationHash }))
    const nextEpisode = Result.getOrThrow(
      paperObserveSuccessorGenerationHash({
        previousPaperGenerationHash: hash('3'),
      }),
    )

    expect(first).toBe(replay)
    expect(first).not.toBe(previousPaperGenerationHash)
    expect(nextEpisode).not.toBe(first)
  })

  test('does not reconcile or rotate when no blocked generation exists', async () => {
    const blockedIntents: BlockedCycleIntentStoreShape = {
      terminalizeUntouchedApproved: () => Effect.die(new Error('cycle terminalization is outside startup recovery')),
      settleCurrentBlockedGeneration: () => Effect.succeed({ _tag: 'NoBlockedGeneration' }),
    }
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: () => Effect.die(new Error('no blocked generation must not rotate authority')),
    }

    const receipt = await Effect.runPromise(
      recoverBlockedGenerationToObserve({
        accountId: 'paper-account',
        blockedIntents,
        authorityStore,
        writerFence: unusedWriterFence,
        reconcileAfterSettlement: Effect.die(new Error('no blocked generation must not reconcile')),
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
                  operation: 'blocked-generation-recovery',
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
    expect(failure.message).toBe('restricted generation recovery found no blocked generation to roll over')
  })

  test('keeps activation disabled when the fresh reconciliation fails', async () => {
    const operations: string[] = []
    const reconciliationFailure = new Error('read-only reconciliation failed')

    const failure = await Effect.runPromise(
      Effect.flip(
        refreshResearchPaperActivationReconciliation(Effect.fail(reconciliationFailure), 1_000).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operations.push('activate')
            }),
          ),
        ),
      ),
    )

    expect(operations).toEqual([])
    expect(failure.message).toBe('research PAPER pre-activation reconciliation failed')
    expect(failure.cause).toBe(reconciliationFailure)
  })

  test('times out and interrupts pre-activation reconciliation before activation', async () => {
    const operations: string[] = []
    const timeoutFailure = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalizations = yield* Ref.make(0)
        const activation = yield* refreshResearchPaperActivationReconciliation(
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
    expect(timeoutFailure.message).toBe('research PAPER pre-activation reconciliation failed')
    expect(timeoutFailure.cause).toMatchObject({
      message: 'research PAPER pre-activation reconciliation timed out',
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
        yield* restrictExpiredPaperActivation(authorityRestrictionStore, writerFence)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(restrictions).toEqual([
      {
        reason: 'PAPER activation lease restricted effective authority: immutable activation request expired',
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
        const finalized = yield* finalizePaperEpisode(
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
    expect(restrictions).toEqual(['PAPER episode restricted effective authority: flat exact receipt finalized'])
    expect(result.state.paperActivation).toEqual({
      _tag: 'Completed',
      requestHash: researchRequest.requestHash,
      generationHash: hash('2'),
      grant: 'Research',
      receiptHash: hash('a'),
    })
    expect(result.state.broker).toMatchObject({
      executionEligible: false,
      executionDisabledReason: 'PAPER_EPISODE_COMPLETED',
    })
  })
})
