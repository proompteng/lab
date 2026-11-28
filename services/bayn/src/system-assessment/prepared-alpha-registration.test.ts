import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { testHash } from './fixtures.test-support'
import {
  preparedAlphaSystemLatencyStressProtocolHash,
  strategyBoundSystemLatencyStressProtocolHash,
} from './latency-protocol'
import {
  isNativeSystemRegistration,
  isStrategyBoundSystemRegistration,
  preparedAlphaSystemQualificationPolicyHash,
  strategyBoundSystemQualificationPolicyHash,
  validateProspectiveSystemRegistration,
  validateSystemRegistration,
  verifyStoredSystemRegistration,
} from './policy'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'

describe('prospective alpha preparation version boundary', () => {
  test('retained engine-bound registration and protocol hashes reproduce unchanged', () => {
    const retained = strategyBoundRegistrationFixture()
    const hash = testHash(retained)
    expect(Result.getOrThrow(strategyBoundSystemQualificationPolicyHash())).toBe(
      'ff34eef46ed69fb9e4f6398d54e00da7f3b4cee246252a1f909fae0d79e01fd8',
    )
    expect(Result.getOrThrow(strategyBoundSystemLatencyStressProtocolHash())).toBe(
      'a4e429ea32e3d9544007aa1106727390a7822d3e521bbc6866245826c1d2b39d',
    )
    expect(Result.getOrThrow(validateSystemRegistration(retained)).registrationHash).toBe(hash)
    expect(Result.getOrThrow(verifyStoredSystemRegistration(retained)).registration).toEqual(retained)
    expect(Result.isFailure(validateProspectiveSystemRegistration(retained))).toBe(true)
  })

  test('new registration binds prospective preparation without changing its frozen engine or risk material', () => {
    const retained = strategyBoundRegistrationFixture()
    const prepared = preparedAlphaRegistrationFixture()
    const verified = Result.getOrThrow(validateProspectiveSystemRegistration(prepared))
    expect(verified.registration.schemaVersion).toBe('bayn.system-registration.v7')
    expect(prepared.policies).toEqual(retained.policies)
    expect(prepared.obligations).toEqual(retained.obligations)
    expect(prepared.statisticalPlan).toEqual(retained.statisticalPlan)
    expect(prepared.costAllocationPlans).toEqual(retained.costAllocationPlans)
    expect(prepared.policyHash).toBe(Result.getOrThrow(preparedAlphaSystemQualificationPolicyHash()))
    expect(prepared.latencyStressProtocolHash).toBe(Result.getOrThrow(preparedAlphaSystemLatencyStressProtocolHash()))
    expect(isNativeSystemRegistration(prepared)).toBe(true)
    expect(isStrategyBoundSystemRegistration(prepared)).toBe(true)
    expect(Result.getOrThrow(verifyStoredSystemRegistration(prepared)).registrationHash).toBe(testHash(prepared))
  })

  test('schema relabeling and mixed preparation protocol identities are rejected', () => {
    const retained = strategyBoundRegistrationFixture()
    const prepared = preparedAlphaRegistrationFixture()
    for (const input of [
      { ...retained, schemaVersion: prepared.schemaVersion },
      { ...prepared, schemaVersion: retained.schemaVersion },
      { ...prepared, policyHash: retained.policyHash },
      { ...prepared, latencyStressProtocolHash: retained.latencyStressProtocolHash },
      { ...retained, policyHash: prepared.policyHash },
      { ...retained, latencyStressProtocolHash: prepared.latencyStressProtocolHash },
    ]) {
      expect(Result.isFailure(validateSystemRegistration(input))).toBe(true)
      expect(Result.isFailure(verifyStoredSystemRegistration(input))).toBe(true)
    }
  })
})
