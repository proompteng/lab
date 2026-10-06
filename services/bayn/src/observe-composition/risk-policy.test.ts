import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { BrokerEnvironment } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
import { executionMandateAllocationCapitalMicros } from '../execution/mandate'
import { fixtureProtocol, fixtureRuntime } from '../testing/runtime-fixtures'
import { loadExecutionRiskPolicy, loadQuoteBoundExecutionRiskPolicy } from './decision-builder'
import { loadStrategyExecutionRiskPolicy } from './startup'

test('raises only sandbox daily turnover and preserves the complete live policy', async () => {
  const [legacy, live, paper] = await Effect.runPromise(
    Effect.all([
      loadQuoteBoundExecutionRiskPolicy('build-contract', fixtureProtocol.universe),
      loadQuoteBoundExecutionRiskPolicy('build-contract', fixtureProtocol.universe, BrokerEnvironment.Live),
      loadQuoteBoundExecutionRiskPolicy('build-contract', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
    ]),
  )
  expect(live).toEqual(legacy)
  expect(Result.getOrThrow(canonicalHashV1Result(live))).toBe(
    '2e60270036900493a121a87c73730960154278778a8aa71b663b138effd82227',
  )
  expect(live.maxDailyTradedNotionalMicros).toBe('200000000000')
  expect(paper).toEqual({ ...live, maxDailyTradedNotionalMicros: '1000000000000' })
})

test('strategy startup and quote-bound loaders select the same environment-specific policy', async () => {
  for (const environment of [BrokerEnvironment.Live, BrokerEnvironment.Sandbox]) {
    const approved = await Effect.runPromise(
      loadQuoteBoundExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
    )
    const policyHash = Result.getOrThrow(canonicalHashV1Result(approved))
    const [strategy, quote, execution] = await Effect.runPromise(
      Effect.all([
        loadStrategyExecutionRiskPolicy('test-account', fixtureRuntime, environment, policyHash),
        loadQuoteBoundExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
        loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, fixtureProtocol.executionModel, environment),
      ]),
    )
    expect(strategy).toEqual(quote)
    expect(execution).toEqual(quote)
  }
})

test('retained sandbox mandates keep the exact original policy until explicitly rebound', async () => {
  const original = await Effect.runPromise(loadStrategyExecutionRiskPolicy('test-account', fixtureRuntime))
  const hash = Result.getOrThrow(canonicalHashV1Result(original))
  const [retained, unbound] = await Effect.runPromise(
    Effect.all([
      loadStrategyExecutionRiskPolicy('test-account', fixtureRuntime, BrokerEnvironment.Sandbox, hash),
      loadStrategyExecutionRiskPolicy('test-account', fixtureRuntime, BrokerEnvironment.Sandbox),
    ]),
  )
  expect(retained).toEqual(original)
  expect(unbound).toEqual(original)
  expect(retained.maxDailyTradedNotionalMicros).toBe('200000000000')
})

test('unknown, foreign-account and live increased-policy hashes fail closed', async () => {
  const paper = await Effect.runPromise(
    loadQuoteBoundExecutionRiskPolicy('test-account', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
  )
  const paperHash = Result.getOrThrow(canonicalHashV1Result(paper))
  for (const [accountId, environment, hash] of [
    ['test-account', BrokerEnvironment.Sandbox, 'f'.repeat(64)],
    ['foreign-account', BrokerEnvironment.Sandbox, paperHash],
    ['test-account', BrokerEnvironment.Live, paperHash],
  ] as const) {
    const result = await Effect.runPromise(
      loadStrategyExecutionRiskPolicy(accountId, fixtureRuntime, environment, hash).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure.message).toBe('bound execution risk policy is not approved for this broker environment')
  }
})

test('pipeable policy loaders preserve explicit sandbox selection', async () => {
  const [quote, execution] = await Effect.runPromise(
    Effect.all([
      loadQuoteBoundExecutionRiskPolicy(fixtureProtocol.universe, BrokerEnvironment.Sandbox)('test-account'),
      loadExecutionRiskPolicy(
        fixtureProtocol.universe,
        fixtureProtocol.executionModel,
        BrokerEnvironment.Sandbox,
      )('test-account'),
    ]),
  )
  expect(quote.maxDailyTradedNotionalMicros).toBe('1000000000000')
  expect(execution).toEqual(quote)
})

test('rebinding a sandbox mandate preserves accumulated turnover while enabling the new budget', async () => {
  const dailyTradedNotionalMicros = 250_000_000_000n
  for (const environment of [BrokerEnvironment.Live, BrokerEnvironment.Sandbox]) {
    const candidate = await Effect.runPromise(
      loadQuoteBoundExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
    )
    const policy = await Effect.runPromise(
      loadStrategyExecutionRiskPolicy(
        'test-account',
        fixtureRuntime,
        BrokerEnvironment.Sandbox,
        Result.getOrThrow(canonicalHashV1Result(candidate)),
      ),
    )
    const capital = Result.getOrThrow(
      executionMandateAllocationCapitalMicros({
        accountEquityMicros: 100_000_000_000n,
        dailyTradedNotionalMicros,
        maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
        maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
        maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
        maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
        targetWeights: { NVDA: 0.2 },
        positions: [],
        referencePriceMicros: {},
      }),
    )
    expect(capital).toBe(environment === BrokerEnvironment.Sandbox ? 100_000_000_000n : 0n)
  }
})
