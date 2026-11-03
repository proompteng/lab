import { Result, Schema } from 'effect'

import originalProtocol from './original-v28-protocol.test-fixture.json'
import { HistoricalJevProtocolSchema } from '../jev/protocol'
import { JevAcceptanceVersion, JevResearchPolicy } from '../jev/acceptance'
import { canonicalHashV1Result, sha256 } from '../hash'
import { makeStrategyProtocolHashResult } from '../contracts'
import {
  entryAblationStrategyIdentity,
  historicalAblationQuestionPolicyHash,
  makeEntryAblationPolicy,
} from '../jev/entry-ablation-policy'
import { makeRepeatedMomentumPolicy, repeatedMomentumStrategyIdentity } from '../strategy/repeated-momentum/policy'
import { registrationFixture, withRegistrationCommitments } from './fixtures.test-support'

// Default protocol extracted from the original source and dependency Git objects at 2d979badfb513934bfbbbf3317ee7d60830fac50.
export const historicalRegistrationFixture = (registeredAt?: string) => {
  const protocol = Result.getOrThrow(Schema.decodeUnknownResult(HistoricalJevProtocolSchema)(originalProtocol))
  const base = registrationFixture(registeredAt, 20, JevAcceptanceVersion.RetainedV2)
  const promptsHash = Result.getOrThrow(historicalAblationQuestionPolicyHash(protocol))
  const ablation = Result.getOrThrow(entryAblationStrategyIdentity(makeEntryAblationPolicy(protocol, promptsHash)))
  const momentum = Result.getOrThrow(repeatedMomentumStrategyIdentity(makeRepeatedMomentumPolicy(protocol)))
  const parametersHash = Result.getOrThrow(canonicalHashV1Result(protocol))
  const strategyHash = sha256('bayn.chart-first-entry.behavior.v1')
  const protocolHash = Result.getOrThrow(
    makeStrategyProtocolHashResult({
      name: 'jev',
      behaviorHash: strategyHash,
      parameterHash: parametersHash,
      parameterSchemaVersion: protocol.schemaVersion,
    }),
  )
  return withRegistrationCommitments({
    ...base,
    obligations: { ...base.obligations, configuration: { ...base.obligations.configuration, protocol } },
    policies: base.policies.map((policy) => {
      switch (policy.policy) {
        case JevResearchPolicy.Candidate:
          return { ...policy, strategyHash, parametersHash, protocolHash }
        case JevResearchPolicy.Ablation:
          return {
            ...policy,
            executionModelHash: Result.getOrThrow(canonicalHashV1Result(protocol.executionModel)),
            promptsHash,
            parametersHash: ablation.strategy.parameterHash,
            protocolHash: ablation.protocolHash,
          }
        case JevResearchPolicy.Momentum:
          return {
            ...policy,
            executionModelHash: Result.getOrThrow(canonicalHashV1Result(protocol.executionModel)),
            parametersHash: momentum.strategy.parameterHash,
            protocolHash: momentum.protocolHash,
          }
        case JevResearchPolicy.Deployed:
          return policy
      }
    }),
  })
}
