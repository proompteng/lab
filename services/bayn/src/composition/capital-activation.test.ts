import { expect, test } from 'bun:test'
import { Effect, Redacted, Result } from 'effect'

import type { ApplicationPlanFor } from '../app'
import { alpacaSandboxBaseUrl } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { makeStrategyProtocolHashResult } from '../contracts'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import {
  makeResearchCapitalActivationRequest,
  makeResearchCapitalPlanHash,
  type ResearchCapitalActivationRequest,
} from '../execution/configuration'
import { config, fixtureRuntime } from '../testing/runtime-fixtures'
import { AccountStatus, ReconciliationStatus } from '../execution/contracts'
import type { ReconciledBrokerState } from '../reconciliation'
import {
  configuredCapitalActivation,
  refreshResearchCapitalActivationReconciliation,
  validateResearchCapitalPreflight,
} from './capital-activation'

const accountId = '123e4567-e89b-42d3-a456-426614174000'
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)
const strategy = {
  ...fixtureRuntime.provenance.strategy,
  protocolHash: Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
}
const request = (overrides: Partial<ResearchCapitalActivationRequest['strategy']> = {}) => {
  const material: Omit<ResearchCapitalActivationRequest, 'schemaVersion' | 'grant' | 'requestHash'> = {
    activation: {
      sourceRevision: config.build.sourceRevision,
      imageRepository: config.build.imageRepository,
      imageDigest: config.build.imageDigest,
    },
    strategy: { ...strategy, ...overrides },
    broker: { environment: BrokerEnvironment.Sandbox, accountId, identityHash: identity.identityHash },
    riskPolicyHash: 'a'.repeat(64),
    limits: { maxOpenOrders: 0, maxPositions: 0 } as const,
  }
  const planHash = Result.getOrThrow(
    makeResearchCapitalPlanHash({ schemaVersion: 'bayn.research-execution-plan.v1', ...material }),
  )
  return Result.getOrThrow(
    makeResearchCapitalActivationRequest({
      schemaVersion: 'bayn.research-execution-mandate.v1',
      grant: { _tag: 'Research', planHash },
      ...material,
    }),
  )
}
const plan = (serialized?: string): ApplicationPlanFor<'AutonomousService'> => ({
  _tag: 'AutonomousService',
  config: {
    ...config,
    runtimeMode: 'AutonomousService',
    execution: {
      brokerIdentity: identity,
      brokerAccess: BrokerAccess.ReadOnly,
      capitalAuthority: { _tag: CapitalAuthorityKind.None },
    },
    capitalActivationRequestJson: serialized,
    cyclePollIntervalMs: 30_000,
    alpaca: {
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      identity,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      authorityGenerationHash: 'b'.repeat(64),
      key: Redacted.make('fixture-key'),
      secret: Redacted.make('fixture-secret'),
      proxyUrl: 'http://proxy.test:3128',
      operationTimeoutMs: 30_000,
      retryAttempts: 0,
      reconciliationIntervalMs: 30_000,
    },
  },
  strategy: fixtureRuntime,
  parameterHash: strategy.parameterHash,
  strategyProtocolHash: strategy.protocolHash,
})

test('rejects an otherwise valid sealed mandate for the previous strategy before runtime preparation', () => {
  for (const [field, message] of [
    ['behaviorHash', 'capital activation request strategy identity does not match the current strategy'],
    ['protocolHash', 'capital activation request strategy protocol does not match the current strategy'],
  ] as const) {
    const previous = request({ [field]: 'f'.repeat(64) })
    expect(configuredCapitalActivation(plan(JSON.stringify(previous)))).toEqual(Result.fail(message))
  }
})

test('retains the exact compatible mandate without changing its account or risk binding', () => {
  const current = request()
  expect(configuredCapitalActivation(plan(JSON.stringify(current)))).toEqual(
    Result.succeed({ request: current, buildContinuation: null, buildLineage: null }),
  )
})

test('rejects malformed sealed content with its configuration reason', () => {
  expect(configuredCapitalActivation(plan('{'))).toEqual(Result.fail('configured capital activation is not valid JSON'))
})

test('requires a mandate for mutation access while allowing an unconfigured read-only runtime', () => {
  const readOnly = plan()
  expect(configuredCapitalActivation(readOnly)).toEqual(Result.succeed(null))
  expect(
    configuredCapitalActivation({
      ...readOnly,
      config: {
        ...readOnly.config,
        execution: {
          brokerIdentity: identity,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: { _tag: CapitalAuthorityKind.Granted, authorityGenerationHash: 'b'.repeat(64) },
        },
      },
    }),
  ).toEqual(Result.fail('configured granted capital requires an immutable execution mandate request'))
})

test('activation consumes the current reconciliation rather than the startup position count', async () => {
  const at = '2026-09-25T15:10:15.000Z'
  const flat: ReconciledBrokerState = {
    account: {
      schemaVersion: 'bayn.paper-account-snapshot.v1',
      accountId,
      status: AccountStatus.Active,
      currency: 'USD',
      cashMicros: '100000000000',
      equityMicros: '100000000000',
      buyingPowerMicros: '100000000000',
      observedAt: at,
    },
    positions: [],
    orders: [],
    positionsObservedAt: at,
    ordersObservedAt: at,
    accountingHash: '1'.repeat(64),
    unknownOrderCount: 0,
    reconciliation: {
      schemaVersion: 'bayn.paper-reconciliation.v1',
      accountId,
      reconciliationId: '2'.repeat(64),
      contentHash: '3'.repeat(64),
      expectedHash: '4'.repeat(64),
      observedHash: '4'.repeat(64),
      status: ReconciliationStatus.Exact,
      discrepancies: [],
      reconciledAt: at,
    },
  }
  const occupied: ReconciledBrokerState = {
    ...flat,
    positions: [
      {
        schemaVersion: 'bayn.paper-position.v1',
        accountId,
        symbol: 'AAPL',
        quantityMicros: '6000000',
        averageEntryPriceMicros: '335970000',
        marketPriceMicros: '335970000',
        marketValueMicros: '2015820000',
        unrealizedPnlMicros: '0',
        observedAt: at,
      },
    ],
  }
  let current = occupied
  const reconcile = Effect.sync(() => ({ report: { reconciliation: current.reconciliation }, brokerState: current }))
  const activate = refreshResearchCapitalActivationReconciliation(reconcile, 1000).pipe(
    Effect.map((result) => validateResearchCapitalPreflight(request(), result.brokerState)),
  )
  expect(Result.isFailure(await Effect.runPromise(activate))).toBe(true)
  current = flat
  expect(await Effect.runPromise(activate)).toEqual(Result.succeed(undefined))
  current = occupied
  expect(Result.isFailure(await Effect.runPromise(activate))).toBe(true)
  expect(Result.isFailure(validateResearchCapitalPreflight(request(), { ...flat, unknownOrderCount: 1 }))).toBe(true)
  expect(
    Result.isFailure(
      validateResearchCapitalPreflight(request(), {
        ...flat,
        account: { ...flat.account, accountId: 'different-account' },
      }),
    ),
  ).toBe(true)
})
