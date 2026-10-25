import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { BrokerEnvironment } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
import { executionMandateAllocationCapitalMicros } from '../execution/mandate'
import { fixtureProtocol, fixtureRuntime } from '../testing/runtime-fixtures'
import { loadExecutionRiskPolicy } from './decision-builder'
import { loadStrategyExecutionRiskPolicy } from './startup'
import { accountEntryProtectionReasons, accountLossMicros, Reason } from '../risk'

test('raises sandbox turnover and cumulative drawdown budgets while preserving the complete live policy', async () => {
  const [legacy, live, paper] = await Effect.runPromise(
    Effect.all([
      loadExecutionRiskPolicy('build-contract', fixtureProtocol.universe),
      loadExecutionRiskPolicy('build-contract', fixtureProtocol.universe, BrokerEnvironment.Live),
      loadExecutionRiskPolicy('build-contract', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
    ]),
  )
  expect(live).toEqual(legacy)
  expect(Result.getOrThrow(canonicalHashV1Result(live))).toBe(
    '75f41cdcde135541b3f65ae243d5b550e974e2074112e39f250b16e780591108',
  )
  expect(live.maxDailyTradedNotionalMicros).toBe('200000000000')
  expect(paper).toEqual({ ...live, maxDailyTradedNotionalMicros: '1000000000000', maxDrawdownMicros: '10000000000' })
})

test('PAPER rebinding retains historical losses and enforces its new drawdown and unchanged daily cap', async () => {
  const policy = await Effect.runPromise(
    loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
  )
  const facts = {
    accountEquityMicros: 94_900_000_000n,
    dayStartEquityMicros: 95_000_000_000n,
    peakEquityMicros: 100_000_000_000n,
  }
  expect(accountLossMicros(facts)).toEqual({ dailyLossMicros: 100_000_000n, drawdownMicros: 5_100_000_000n })
  expect(accountEntryProtectionReasons(facts, { ...policy, maxDrawdownMicros: '5000000000' })).toEqual([
    Reason.DrawdownExceeded,
  ])
  expect(accountEntryProtectionReasons(facts, policy)).toEqual([])
  expect(accountEntryProtectionReasons({ ...facts, accountEquityMicros: 90_000_000_000n }, policy)).toEqual([])
  expect(accountEntryProtectionReasons({ ...facts, accountEquityMicros: 89_999_999_999n }, policy)).toEqual([
    Reason.DailyLossExceeded,
    Reason.DrawdownExceeded,
  ])
  expect(accountLossMicros(facts).drawdownMicros).toBe(5_100_000_000n)
})

test('strategy startup and quote-bound loaders select the same environment-specific policy', async () => {
  for (const environment of [BrokerEnvironment.Live, BrokerEnvironment.Sandbox]) {
    const approved = await Effect.runPromise(
      loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
    )
    const policyHash = Result.getOrThrow(canonicalHashV1Result(approved))
    const [strategy, quote, execution] = await Effect.runPromise(
      Effect.all([
        loadStrategyExecutionRiskPolicy('test-account', fixtureRuntime, environment, policyHash),
        loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
        loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
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
    loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
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
      loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
      loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, BrokerEnvironment.Sandbox),
    ]),
  )
  expect(quote.maxDailyTradedNotionalMicros).toBe('1000000000000')
  expect(execution).toEqual(quote)
})

test('rebinding a sandbox mandate preserves accumulated turnover while enabling the new budget', async () => {
  const dailyTradedNotionalMicros = 250_000_000_000n
  for (const environment of [BrokerEnvironment.Live, BrokerEnvironment.Sandbox]) {
    const candidate = await Effect.runPromise(
      loadExecutionRiskPolicy('test-account', fixtureProtocol.universe, environment),
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
