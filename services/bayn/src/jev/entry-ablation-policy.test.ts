import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { fixtureProtocol, fixtureRuntime } from '../testing/runtime-fixtures'
import { makeEntryAblationRuntime } from '../strategy'
import { prepareObserveStartup } from '../observe-composition/startup'
import {
  decodeEntryAblationPolicy,
  entryAblationStrategyIdentity,
  makeEntryAblationPolicy,
} from './entry-ablation-policy'

test('ablation identity commits its whole policy while retaining the exact shared execution protocol', () => {
  const policy = makeEntryAblationPolicy(fixtureProtocol)
  const identity = Result.getOrThrow(entryAblationStrategyIdentity(policy))
  expect(policy.sharedProtocol).toEqual(fixtureProtocol)
  expect(identity.strategy.parameterSchemaVersion).toBe('bayn.entry-ablation-policy.v1')
  expect(identity.strategy.parameterHash).toBe(Result.getOrThrow(canonicalHashV1Result(policy)))
  expect(identity.strategy.parameterHash).not.toBe(fixtureRuntime.provenance.strategy.parameterHash)
  expect(identity.strategy.behaviorHash).not.toBe(fixtureRuntime.provenance.strategy.behaviorHash)
  expect(identity.protocolHash).not.toBe(
    Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
  )
  for (const replacement of [
    { selectionPolicy: 'HIGHEST_TARGET' },
    { jevStage: 'RECEIVED' },
    { questionPolicyHash: 'f'.repeat(64) },
    { omittedProvider: 'openai' },
  ])
    expect(Result.isFailure(decodeEntryAblationPolicy({ ...policy, ...replacement }))).toBe(true)
})

test('native ablation startup preserves shared risk and timing and rejects a retuned or mislabeled policy', () => {
  const policy = makeEntryAblationPolicy(fixtureProtocol)
  const identity = Result.getOrThrow(entryAblationStrategyIdentity(policy))
  const runtime = makeEntryAblationRuntime(policy, { ...fixtureRuntime.provenance, strategy: identity.strategy })
  const input = {
    accountId: 'ablation-policy-test',
    authorityGenerationHash: 'a'.repeat(64),
    pollIntervalMs: 30000,
    reconciliationIntervalMs: 30000,
    reconciliationPassTimeoutMs: 30000,
    strategy: runtime,
  }
  const prepared = Result.getOrThrow(prepareObserveStartup(input))
  expect(prepared.strategyProtocolHash).toBe(identity.protocolHash)
  expect(prepared.executionModel).toEqual(fixtureProtocol.executionModel)
  const retuned = makeEntryAblationPolicy({ ...fixtureProtocol, maximumGrossWeight: 0.1, maximumSymbolWeight: 0.1 })
  const retunedIdentity = Result.getOrThrow(entryAblationStrategyIdentity(retuned))
  expect(retunedIdentity.protocolHash).not.toBe(identity.protocolHash)
  for (const strategy of [
    makeEntryAblationRuntime(retuned, { ...fixtureRuntime.provenance, strategy: retunedIdentity.strategy }),
    makeEntryAblationRuntime(policy, fixtureRuntime.provenance),
  ])
    expect(Result.isFailure(prepareObserveStartup({ ...input, strategy }))).toBe(true)
})
