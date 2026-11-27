import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { nativeReplayPolicyIdentity, nativeReplayPolicyManifest } from '../intraday-replay/native-policy'
import { JevResearchPolicy } from '../jev/acceptance'
import { makeEntryAblationPolicy } from '../jev/entry-ablation-policy'
import { loadSharedJevProtocol } from '../strategy'
import { intradayAlphaPromptsHash, makeIntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import { makeRepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'
import frozenProtocol from './fixtures/frozen-control-protocol.json'
import { frozenControlOrigin, frozenDeployedControlIdentity } from './frozen-control-identity'
import {
  ResearchStrategyEngine,
  makeResearchStrategyBinding,
  researchStrategyEngineMatchesRole,
  researchStrategyInferenceModels,
  researchStrategyPolicyMaterial,
  researchStrategyProtocol,
  validateResearchStrategyBinding,
} from './strategy-binding'

const protocol = Result.getOrThrow(loadSharedJevProtocol())
const jev = Result.getOrThrow(makeResearchStrategyBinding({ engine: ResearchStrategyEngine.Jev, parameters: protocol }))
const alpha = Result.getOrThrow(
  makeResearchStrategyBinding({
    engine: ResearchStrategyEngine.IntradayAlpha,
    parameters: makeIntradayAlphaPolicy(protocol),
  }),
)
const ablation = Result.getOrThrow(
  makeResearchStrategyBinding({
    engine: ResearchStrategyEngine.EntryAblation,
    parameters: makeEntryAblationPolicy(protocol),
  }),
)
const momentum = Result.getOrThrow(
  makeResearchStrategyBinding({
    engine: ResearchStrategyEngine.RepeatedMomentum,
    parameters: makeRepeatedMomentumPolicy(protocol),
  }),
)
const frozen = Result.getOrThrow(
  makeResearchStrategyBinding({ engine: ResearchStrategyEngine.FrozenDeployed, parameters: frozenProtocol }),
)

describe('explicit research engine binding', () => {
  test('retains every legacy native strategy identity without redefining the candidate role', () => {
    for (const [policy, binding] of [
      [JevResearchPolicy.Candidate, jev],
      [JevResearchPolicy.Incumbent, jev],
      [JevResearchPolicy.Ablation, ablation],
      [JevResearchPolicy.Momentum, momentum],
    ] as const) {
      const identity = Result.getOrThrow(nativeReplayPolicyIdentity(policy, protocol))
      expect(binding.strategy).toEqual(identity.strategy)
      expect(binding.protocolHash).toBe(identity.protocolHash)
      expect(Result.getOrThrow(validateResearchStrategyBinding(binding))).toEqual(binding)
      expect(researchStrategyProtocol(binding)).toEqual(protocol)
    }
    const manifest = Result.getOrThrow(nativeReplayPolicyManifest(protocol))
    expect(manifest).toHaveLength(3)
    const candidate = manifest.find((entry) => entry.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined) throw new Error('Missing legacy candidate manifest')
    expect(jev.strategy).toEqual(candidate.strategy)
    expect(alpha.strategy.name).toBe(jev.strategy.name)
    expect(alpha.strategy.parameterHash).not.toBe(jev.strategy.parameterHash)
    expect(alpha.strategy.behaviorHash).not.toBe(jev.strategy.behaviorHash)
    expect(alpha.protocolHash).not.toBe(jev.protocolHash)
    expect(Result.getOrThrow(validateResearchStrategyBinding(alpha))).toEqual(alpha)
  })

  test('binds complete alpha parameters and rejects shared-protocol or engine substitutions', () => {
    for (const candidate of [
      { ...alpha, engine: ResearchStrategyEngine.Jev },
      { ...alpha, parameters: protocol },
      { ...alpha, parameters: { ...makeIntradayAlphaPolicy(protocol), unexpected: true } },
      {
        ...alpha,
        parameters: { ...makeIntradayAlphaPolicy(protocol), schemaVersion: 'bayn.intraday-alpha-policy.v1' },
      },
      { ...alpha, strategy: jev.strategy },
      { ...alpha, strategy: { ...alpha.strategy, parameterHash: jev.strategy.parameterHash } },
      { ...alpha, strategy: { ...alpha.strategy, parameterSchemaVersion: protocol.schemaVersion } },
      { ...alpha, strategy: { ...alpha.strategy, behaviorHash: jev.strategy.behaviorHash } },
      { ...alpha, strategy: { ...alpha.strategy, name: 'intraday-alpha' } },
      { ...alpha, protocolHash: jev.protocolHash },
      { ...alpha, protocolHash: sha256('unrelated protocol') },
      { ...jev, parameters: { ...protocol, schemaVersion: 'bayn.jev.protocol.v43' } },
    ])
      expect(Result.isFailure(validateResearchStrategyBinding(candidate))).toBe(true)
    expect(Result.getOrThrow(canonicalHashV1Result(alpha.parameters))).toBe(alpha.strategy.parameterHash)
  })

  test('rejects all concrete policy schema cross-substitutions', () => {
    for (const binding of [jev, alpha, ablation, momentum, frozen])
      for (const other of [jev, alpha, ablation, momentum, frozen])
        if (binding.engine !== other.engine)
          expect(Result.isFailure(validateResearchStrategyBinding({ ...binding, parameters: other.parameters }))).toBe(
            true,
          )
  })

  test('candidate and incumbent each select an authenticated engine; fixed controls cannot be relabeled', () => {
    const admitted = new Map<JevResearchPolicy, readonly ResearchStrategyEngine[]>([
      [JevResearchPolicy.Candidate, [ResearchStrategyEngine.Jev, ResearchStrategyEngine.IntradayAlpha]],
      [JevResearchPolicy.Incumbent, [ResearchStrategyEngine.Jev, ResearchStrategyEngine.IntradayAlpha]],
      [JevResearchPolicy.Ablation, [ResearchStrategyEngine.EntryAblation]],
      [JevResearchPolicy.Momentum, [ResearchStrategyEngine.RepeatedMomentum]],
      [JevResearchPolicy.Deployed, [ResearchStrategyEngine.FrozenDeployed]],
    ])
    for (const role of Object.values(JevResearchPolicy))
      for (const engine of Object.values(ResearchStrategyEngine))
        expect(researchStrategyEngineMatchesRole(role, engine)).toBe(admitted.get(role)?.includes(engine) ?? false)
  })

  test('frozen control retains every original field and cannot adopt current source parameters', () => {
    expect(frozen.strategy).toEqual({
      name: frozenControlOrigin.strategyName,
      behaviorHash: frozenDeployedControlIdentity.strategyHash,
      parameterHash: frozenDeployedControlIdentity.parametersHash,
      parameterSchemaVersion: frozenControlOrigin.parameterSchemaVersion,
    })
    expect(frozen.protocolHash).toBe(frozenDeployedControlIdentity.protocolHash)
    expect(frozen.parameters).toEqual(frozenProtocol)
    expect(researchStrategyProtocol(frozen)).toBeNull()
    expect(
      Result.isFailure(
        validateResearchStrategyBinding({ ...frozen, parameters: { ...frozenProtocol, maximumPositions: 2 } }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        validateResearchStrategyBinding({
          ...frozen,
          parameters: { ...frozenProtocol, extra: 'not originally frozen' },
        }),
      ),
    ).toBe(true)
  })

  test('provider requirements and continuation derive from engine material, including disabled alpha veto', () => {
    expect(researchStrategyInferenceModels(alpha)).toEqual([])
    expect(researchStrategyInferenceModels(momentum)).toEqual([])
    expect(researchStrategyInferenceModels(frozen)).toEqual([])
    expect(researchStrategyInferenceModels(jev)).toEqual([{ provider: 'typesafe', model: protocol.model }])
    expect(researchStrategyInferenceModels(ablation)).toEqual([{ provider: 'typesafe', model: protocol.model }])
    const material = researchStrategyPolicyMaterial(alpha)
    expect(Result.getOrThrow(canonicalHashV1Result(material.prompts))).toBe(
      Result.getOrThrow(intradayAlphaPromptsHash()),
    )
    expect(Result.getOrThrow(canonicalHashV1Result(material.continuationAndExits))).toBe(
      Result.getOrThrow(
        canonicalHashV1Result({
          schemaVersion: 'bayn.native-alpha-continuation-policy.v1',
          policy: alpha.parameters,
        }),
      ),
    )
    expect(material.executionModel).toEqual(protocol.executionModel)
    expect(
      Result.isFailure(
        validateResearchStrategyBinding({
          ...alpha,
          parameters: {
            ...makeIntradayAlphaPolicy(protocol),
            catalystVeto: { ...makeIntradayAlphaPolicy(protocol).catalystVeto, enabled: true },
          },
        }),
      ),
    ).toBe(true)
  })
})
