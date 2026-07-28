import { describe, expect, test } from 'bun:test'

import { Clock, Deferred, Effect, Fiber, pipe, Redacted } from 'effect'

import {
  config,
  fixtureEvaluation,
  fixtureStrategy,
  marketDataService,
  pinnedEvaluation,
  pinnedRuntimeConfig,
  pinnedStore,
  successfulEvidenceStore,
  successfulJournal,
} from './app-test-support'
import {
  type ApplicationIdentity,
  type AutonomousCycleStartupInput,
  type AutonomousObserveApplicationConfig,
  type BrokerlessApplicationConfig,
  makeApplicationPlan,
  runApplication,
} from './app'
import { AccountStatus, BrokerProvider, alpacaSandboxBaseUrl, type BrokerReadShape } from './broker/alpaca'
import { unusedAssetBySymbol, unusedMarketCalendar } from './broker/alpaca-test-support'
import type { LoadedRuntimeConfig } from './config'
import { makeStrategyProtocolHash } from './contracts'
import { BrokerEnvironment } from './execution/authority'
import type { BrokerProbe } from './health'
import { HttpServerLive } from './http'
import { Authority } from './paper'
import { makeStrategy } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const cycleObservability = {
  read: () =>
    Effect.succeed({
      current: null,
      last: null,
      unfinishedCycleCount: 0,
      authority: null,
      reconciliation: null,
      mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
    }),
}

const brokerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const brokerRead = (): BrokerReadShape => {
  const unused = Effect.die(new Error('application lifecycle test must only read the broker account'))
  return {
    account: Effect.succeed({
      value: {
        id: brokerAccountId,
        status: AccountStatus.Active,
        currency: 'USD',
        cashMicros: '1000000',
        equityMicros: '1000000',
        buyingPowerMicros: '1000000',
        accountBlocked: false,
        tradingBlocked: false,
        tradeSuspendedByUser: false,
        observedAt: '2026-07-20T00:00:00.000Z',
      },
      evidence: {
        requestId: 'application-lifecycle',
        status: 200,
        contentHash: 'a'.repeat(64),
        observedAt: '2026-07-20T00:00:00.000Z',
      },
    }),
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar: unusedMarketCalendar,
  }
}

const broker: BrokerProbe = {
  read: brokerRead(),
  expectedAccountId: brokerAccountId,
  executionEligible: false,
  executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
}

const autonomousConfig = (runtime: typeof config): AutonomousObserveApplicationConfig => ({
  ...runtime,
  runtimeMode: 'AutonomousObserveService',
  cyclePollIntervalMs: 30_000,
  maximumAuthority: Authority.Observe,
  alpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: brokerAccountId,
    authorityGenerationHash: 'f'.repeat(64),
    key: Redacted.make('test-key'),
    secret: Redacted.make('test-secret'),
    proxyUrl: 'http://proxy.test:3128',
    operationTimeoutMs: runtime.operationTimeoutMs,
    retryAttempts: 0,
    reconciliationIntervalMs: 30_000,
  },
})

const brokerlessConfig = (runtime: typeof config): BrokerlessApplicationConfig => ({
  ...runtime,
  runtimeMode: 'BrokerlessService',
  cyclePollIntervalMs: 30_000,
  maximumAuthority: Authority.Observe,
  alpaca: undefined,
})

const discoveryConfig = (
  runtime: typeof pinnedRuntimeConfig,
): Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'PaperCandidateDiscovery' }> => ({
  ...autonomousConfig(runtime),
  runtimeMode: 'PaperCandidateDiscovery',
  qualificationRunId: pinnedEvaluation.runId,
})

const applicationIdentity = (loaded: LoadedRuntimeConfig): ApplicationIdentity => ({
  config: loaded,
  protocol: fixtureProtocol,
  parameterHash: fixtureStrategy.provenance.strategy.parameterHash,
  strategy: fixtureStrategy,
  strategyProtocolHash: makeStrategyProtocolHash(fixtureStrategy.provenance.strategy),
})

describe('Bayn application composition', () => {
  test('constructs one exhaustive immutable application plan for every resolved runtime mode', () => {
    const modes = [
      { config: brokerlessConfig(config), expectedTag: 'BrokerlessService' },
      { config: autonomousConfig(config), expectedTag: 'AutonomousObserveService' },
      { config: discoveryConfig(pinnedRuntimeConfig), expectedTag: 'PaperCandidateDiscovery' },
    ] as const

    for (const mode of modes) {
      const identity = Object.freeze(applicationIdentity(mode.config))
      const plan = makeApplicationPlan(identity)

      expect(plan._tag).toBe(mode.expectedTag)
      expect(plan.config).toBe(mode.config)
      expect(plan.protocol).toBe(identity.protocol)
      expect(plan.strategy).toBe(identity.strategy)
      expect(plan.parameterHash).toBe(identity.parameterHash)
      expect(plan.strategyProtocolHash).toBe(identity.strategyProtocolHash)
      expect(identity).not.toHaveProperty('_tag')
    }
  })

  test('starts one scoped autonomous cycle after initialization and interrupts it with the application', async () => {
    const calls: string[] = []
    let backgroundInterrupted = false
    const marketData = marketDataService(
      Effect.sync(() => {
        calls.push('initialize')
        return makeSnapshot()
      }),
    )
    let startupQualificationRunId: string | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startCycle = ({ qualificationRunId, recordPass }: AutonomousCycleStartupInput) =>
            pipe(
              Effect.sync(() => {
                calls.push('autonomous-cycle')
                startupQualificationRunId = qualificationRunId
              }),
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((millis) => new Date(millis).toISOString()),
              Effect.flatMap((observedAt) => recordPass({ result: 'SUCCESS', observedAt, outcome: 'NO_PUBLICATION' })),
              Effect.as(
                pipe(
                  Deferred.succeed(started, undefined),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => void (backgroundInterrupted = true))),
                ),
              ),
            )
          const fiber = yield* pipe(
            runApplication(
              autonomousConfig(config),
              fixtureStrategy,
              {
                marketData,
                journal: successfulJournal,
                evidenceStore: successfulEvidenceStore,
                cycleObservability,
              },
              { _tag: 'AutonomousObserve', broker, startCycle },
            ),
            Effect.provide(HttpServerLive(config)),
            Effect.forkScoped,
          )
          yield* pipe(Deferred.await(started), Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(calls).toEqual(['initialize', 'autonomous-cycle'])
    expect(startupQualificationRunId).toBe(fixtureEvaluation.runId)
    expect(backgroundInterrupted).toBe(true)
  })

  test('keeps the pinned qualification scope separate from the current decision protocol identity', async () => {
    const currentStrategy = makeStrategy(
      fixtureProtocol,
      makeTestProvenance(fixtureProtocol, { behaviorHash: 'c'.repeat(64) }),
    )
    const currentProtocolHash = makeStrategyProtocolHash(currentStrategy.provenance.strategy)
    expect(currentProtocolHash).not.toBe(pinnedEvaluation.protocolHash)

    let startupQualificationRunId: string | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startCycle = ({ qualificationRunId }: AutonomousCycleStartupInput) =>
            pipe(
              Effect.sync(() => void (startupQualificationRunId = qualificationRunId)),
              Effect.as(pipe(Deferred.succeed(started, undefined), Effect.andThen(Effect.never))),
            )
          const fiber = yield* pipe(
            runApplication(
              autonomousConfig(pinnedRuntimeConfig),
              currentStrategy,
              {
                marketData: marketDataService(Effect.die(new Error('pinned startup must not load Signal bars'))),
                journal: successfulJournal,
                evidenceStore: pinnedStore(),
                cycleObservability,
              },
              { _tag: 'AutonomousObserve', broker, startCycle },
            ),
            Effect.provide(HttpServerLive(pinnedRuntimeConfig)),
            Effect.forkScoped,
          )
          yield* pipe(Deferred.await(started), Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(startupQualificationRunId).toBe(pinnedEvaluation.runId)
  })
})
