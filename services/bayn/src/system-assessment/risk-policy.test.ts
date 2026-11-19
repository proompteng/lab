import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { registrationFixture, testHash } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { BrokerEnvironment } from '../broker/identity'

test('an arbitrary risk-policy hash cannot authorize prospective qualification', () => {
  const registration = registrationFixture()
  for (const definition of registration.policies) {
    const changed = {
      ...registration,
      policies: registration.policies.map((policy) =>
        policy.policy === definition.policy ? { ...policy, riskPolicyHash: testHash('expanded limits') } : policy,
      ),
    }
    expect(Result.isFailure(validateSystemRegistration(changed))).toBe(true)
  }
})

test('qualification derives its limits from the existing approved execution policy', () => {
  const registration = registrationFixture()
  for (const environment of [BrokerEnvironment.Live, BrokerEnvironment.Sandbox]) {
    const policies = registration.policies.map((definition) => {
      const riskPolicy = Result.getOrThrow(
        makeExecutionRiskPolicy(definition.riskPolicy.accountId, definition.riskPolicy.allowedSymbols, environment),
      )
      return { ...definition, riskPolicy, riskPolicyHash: testHash(riskPolicy) }
    })
    expect(Result.isSuccess(validateSystemRegistration({ ...registration, policies }))).toBe(true)
  }
})

test('rehashed expanded limits and a foreign account cannot become an approved risk policy', () => {
  const registration = registrationFixture()
  for (const definition of registration.policies) {
    const original = definition.riskPolicy
    for (const riskPolicy of [
      ...[
        'maxOrderNotionalMicros',
        'maxSymbolExposureMicros',
        'maxGrossExposureMicros',
        'maxNetExposureMicros',
        'maxDailyTradedNotionalMicros',
        'maxDailyLossMicros',
        'maxDrawdownMicros',
      ].map((key) => ({ ...original, [key]: '9999999999999' })),
      { ...original, maxIntentAgeMs: original.maxIntentAgeMs + 1 },
      { ...original, maxBrokerStateAgeMs: original.maxBrokerStateAgeMs + 1 },
      { ...original, maxMarketDataAgeMs: original.maxMarketDataAgeMs + 1 },
      { ...original, maxAdverseSlippageBps: original.maxAdverseSlippageBps + 1 },
      { ...original, maxOpenOrders: original.maxOpenOrders + 1 },
      { ...original, decisionTtlMs: original.decisionTtlMs + 1 },
      { ...original, accountId: 'foreign-account' },
    ]) {
      const policies = registration.policies.map((policy) =>
        policy.policy === definition.policy ? { ...policy, riskPolicy, riskPolicyHash: testHash(riskPolicy) } : policy,
      )
      expect(Result.isFailure(validateSystemRegistration({ ...registration, policies }))).toBe(true)
    }
  }
})
