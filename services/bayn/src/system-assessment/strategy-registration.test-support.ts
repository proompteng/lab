import { Result, Schema } from 'effect'

import { JevResearchPolicy } from '../jev/acceptance'
import { makeEntryAblationPolicy } from '../jev/entry-ablation-policy'
import { JevProtocolSchema } from '../jev/protocol'
import { makeIntradayAlphaPolicy, makePureEtfPolicy } from '../strategy/intraday-alpha/policy'
import { makeRepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'
import { executionControllerPlanHash } from '../execution/controller-plan'
import { MarketKind } from '../instruments'
import { strictParseOptions } from '../schemas'
import frozenProtocol from './fixtures/frozen-control-protocol.json'
import {
  nativeRegistrationFixture,
  registrationFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import { StrategyBoundSystemRegistrationSchema, strategyBoundSystemQualificationPolicyHash } from './policy'
import { strategyBoundSystemLatencyStressProtocolHash } from './latency-protocol'
import {
  ResearchStrategyEngine,
  ServingResearchStrategyBindingSchema,
  makeResearchStrategyBinding,
  researchStrategyInferenceModels,
  researchStrategyPolicyMaterial,
  type ResearchStrategyMaterial,
} from './strategy-binding'

export const strategyBoundRegistrationFixture = (
  base = nativeRegistrationFixture(registrationFixture(undefined, 2)),
  engines: {
    readonly candidate?:
      | ResearchStrategyEngine.Jev
      | ResearchStrategyEngine.IntradayAlpha
      | ResearchStrategyEngine.PureEtf
    readonly incumbent?:
      | ResearchStrategyEngine.Jev
      | ResearchStrategyEngine.IntradayAlpha
      | ResearchStrategyEngine.PureEtf
  } = {},
) => {
  const protocol = Schema.decodeUnknownSync(
    JevProtocolSchema,
    strictParseOptions,
  )(base.obligations.configuration.protocol)
  const policies = base.policies.map((definition) => {
    const engine =
      definition.policy === JevResearchPolicy.Candidate
        ? (engines.candidate ?? ResearchStrategyEngine.IntradayAlpha)
        : definition.policy === JevResearchPolicy.Incumbent
          ? (engines.incumbent ?? ResearchStrategyEngine.Jev)
          : definition.policy === JevResearchPolicy.Ablation
            ? ResearchStrategyEngine.EntryAblation
            : definition.policy === JevResearchPolicy.Momentum
              ? ResearchStrategyEngine.RepeatedMomentum
              : ResearchStrategyEngine.FrozenDeployed
    const material: ResearchStrategyMaterial =
      engine === ResearchStrategyEngine.IntradayAlpha
        ? { engine, parameters: makeIntradayAlphaPolicy(protocol) }
        : engine === ResearchStrategyEngine.PureEtf
          ? { engine, parameters: makePureEtfPolicy(protocol) }
          : engine === ResearchStrategyEngine.Jev
            ? { engine, parameters: protocol }
            : engine === ResearchStrategyEngine.EntryAblation
              ? { engine, parameters: makeEntryAblationPolicy(protocol) }
              : engine === ResearchStrategyEngine.RepeatedMomentum
                ? { engine, parameters: makeRepeatedMomentumPolicy(protocol) }
                : { engine, parameters: frozenProtocol }
    const strategyBinding = Result.getOrThrow(makeResearchStrategyBinding(material))
    const policyMaterial = researchStrategyPolicyMaterial(strategyBinding)
    return {
      ...definition,
      strategyBinding,
      strategyHash: strategyBinding.strategy.behaviorHash,
      parametersHash: strategyBinding.strategy.parameterHash,
      protocolHash: strategyBinding.protocolHash,
      promptsHash: testHash(policyMaterial.prompts),
      continuationAndExitsHash: testHash(policyMaterial.continuationAndExits),
      executionModelHash: testHash(policyMaterial.executionModel),
      inferenceRateCard:
        researchStrategyInferenceModels(strategyBinding).length === 0
          ? { ...definition.inferenceRateCard, rates: [] }
          : definition.inferenceRateCard,
    }
  })
  const candidate = policies.find((definition) => definition.policy === JevResearchPolicy.Candidate)
  if (candidate === undefined) throw new Error('Missing engine-bound candidate')
  const runtime = base.obligations.configuration
  return Schema.decodeUnknownSync(
    StrategyBoundSystemRegistrationSchema,
    strictParseOptions,
  )(
    withRegistrationCommitments({
      ...base,
      schemaVersion: 'bayn.system-registration.v6',
      policyHash: Result.getOrThrow(strategyBoundSystemQualificationPolicyHash()),
      latencyStressProtocolHash: Result.getOrThrow(strategyBoundSystemLatencyStressProtocolHash()),
      policies,
      obligations: {
        ...base.obligations,
        configuration: {
          schemaVersion: 'bayn.qualification-runtime.v3',
          decisionTrigger: 'streaming',
          controllerPlanHash: executionControllerPlanHash,
          operationTimeoutMs: runtime.operationTimeoutMs,
          reconciliationIntervalMs: runtime.reconciliationIntervalMs,
          reconciliationStaleThresholdMs: runtime.reconciliationStaleThresholdMs,
          unknownMutationThresholdMs: runtime.unknownMutationThresholdMs,
          entryMarkets: [MarketKind.Equity],
          protocol,
          strategyBinding: Schema.decodeUnknownSync(
            ServingResearchStrategyBindingSchema,
            strictParseOptions,
          )(candidate.strategyBinding),
        },
      },
    }),
  )
}
